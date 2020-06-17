'use strict';

const _ = require('lodash')
const validate = require('jsonschema').validate
const schema = require('./schema.json');
const utils = require('./utils')
const methods = require('./methods')
const compileRestApi = require('serverless/lib/plugins/aws/package/compile/events/apiGateway/lib/restApi')
const compileResources = require('serverless/lib/plugins/aws/package/compile/events/apiGateway/lib/resources')
const compileCors = require('serverless/lib/plugins/aws/package/compile/events/apiGateway/lib/cors')
const compileDeployment = require('serverless/lib/plugins/aws/package/compile/events/apiGateway/lib/deployment')
const getStackInfo = require('serverless/lib/plugins/aws/info/getStackInfo')

class ServerlessPlugin {
  constructor(serverless, options) {
    this.serverless = serverless;
    this.eventBridgeProxies = null;
    this.consoleLog = this.serverless.cli.consoleLog;
    this.validated = null;
    this.options = options || {}
    this.provider = this.serverless.getProvider('aws')
    this.service = this.serverless.service.service
    this.region = this.provider.getRegion()
    this.stage = this.provider.getStage()
    this.apiGatewayMethodLogicalIds = []

    Object.assign(
      this,
      methods,
      utils,
      compileRestApi,
      compileResources,
      compileCors,
      compileDeployment,
      getStackInfo
    );

    this.hooks = {
      'package:compileEvents': async () => {
        this.eventBridgeProxies = _.get(this.serverless, 'service.custom.apiGatewayEventbridgeProxies');
        if (!this.eventBridgeProxies) return;

        const validatedSchema = validate(this.eventBridgeProxies, schema);

        if (validatedSchema.errors.length > 0) {
          throw validatedSchema.errors.join('\n');
        }

        this.validated = await this.validateServiceProxies([...this.eventBridgeProxies])

        await this.compileRestApi()
        await this.compileResources()
        await this.compileCors()

        await this.compileEventBridgeServiceProxy();
        await this.mergeDeployment();
      },
    };
  }

  async compileEventBridgeServiceProxy() {
    this.compileIamRoleToEventBridge()
    this.compileMethodsToEventBridge()
  }

  compileIamRoleToEventBridge() {
    const eventBusNames = this.eventBridgeProxies
      .map((proxy) => proxy.eventBusName)

    const policyResource = eventBusNames.map((eventBusName) => ({
      'Fn::Sub': [
        'arn:aws:events:${AWS::Region}:${AWS::AccountId}:event-bus/${eventBusName}',
        { eventBusName }
      ]
    }))

    const template = {
      Type: 'AWS::IAM::Role',
      Properties: {
        AssumeRolePolicyDocument: {
          Version: '2012-10-17',
          Statement: [
            {
              Effect: 'Allow',
              Principal: {
                Service: 'apigateway.amazonaws.com'
              },
              Action: 'sts:AssumeRole'
            }
          ]
        },
        Policies: [
          {
            PolicyName: 'apigatewaytoeventbridge',
            PolicyDocument: {
              Version: '2012-10-17',
              Statement: [
                {
                  Effect: 'Allow',
                  Action: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
                  Resource: '*'
                },
                {
                  Effect: 'Allow',
                  Action: ['events:PutEvents'],
                  Resource: policyResource
                }
              ]
            }
          }
        ]
      }
    }

    _.merge(this.serverless.service.provider.compiledCloudFormationTemplate.Resources, {
      ApigatewayToEventBridgeRole: template
    })
  }

  compileMethodsToEventBridge() {
    this.validated.events.forEach((event) => {
      const resourceId = this.getResourceId(event.http.path)
      const resourceName = this.getResourceName(event.http.path)

      const template = {
        Type: 'AWS::ApiGateway::Method',
        Properties: {
          HttpMethod: event.http.method.toUpperCase(),
          RequestParameters: event.http.acceptParameters || {},
          AuthorizationType: event.http.auth.authorizationType,
          AuthorizationScopes: event.http.auth.authorizationScopes,
          AuthorizerId: event.http.auth.authorizerId,
          ApiKeyRequired: Boolean(event.http.private),
          ResourceId: resourceId,
          RestApiId: this.provider.getApiGatewayRestApiId()
        }
      }
      _.merge(
        template,
        this.getEventBridgeMethodIntegration(event.http),
        this.getMethodResponses(event.http)
      )

      const methodLogicalId = this.provider.naming.getMethodLogicalId(
        resourceName,
        event.http.method
      )

      this.apiGatewayMethodLogicalIds.push(methodLogicalId)

      _.merge(this.serverless.service.provider.compiledCloudFormationTemplate.Resources, {
        [methodLogicalId]: template
      })
    })
  }

  getEventBridgeMethodIntegration(http) {
    const roleArn = http.roleArn || {
      'Fn::GetAtt': ['ApigatewayToEventBridgeRole', 'Arn']
    }

    const integration = {
      IntegrationHttpMethod: 'POST',
      Type: 'AWS',
      Credentials: roleArn,
      Uri: {
        'Fn::Sub': 'arn:aws:apigateway:${AWS::Region}:events:action/PutEvents'
      },
      PassthroughBehavior: 'NEVER',
      RequestParameters: {
        'integration.request.header.X-Amz-Target': "'AWSEvents.PutEvents'",
        'integration.request.header.Content-Type': "'application/x-amz-json-1.1'"
      },
      RequestTemplates: this.getEventBridgeIntegrationRequestTemplates(http)
    }

    const integrationResponse = {
      IntegrationResponses: [
        {
          StatusCode: 200,
          SelectionPattern: 200,
          ResponseParameters: {},
          ResponseTemplates: {}
        },
        {
          StatusCode: 400,
          SelectionPattern: 400,
          ResponseParameters: {},
          ResponseTemplates: {}
        },
        {
          StatusCode: 500,
          SelectionPattern: 500,
          ResponseParameters: {},
          ResponseTemplates: {}
        }
      ]
    }

    this.addCors(http, integrationResponse)

    _.merge(integration, integrationResponse)

    return {
      Properties: {
        Integration: integration
      }
    }
  }

  getEventBridgeIntegrationRequestTemplates(http) {
    const defaultRequestTemplates = this.getDefaultEventBridgeRequestTemplates(http)
    return Object.assign(defaultRequestTemplates, _.get(http, ['request', 'template']))
  }

  getDefaultEventBridgeRequestTemplates(http) {
    return {
      'application/json': this.buildDefaultEventBridgeRequestTemplate(http),
      'application/x-www-form-urlencoded': this.buildDefaultEventBridgeRequestTemplate(http)
    }
  }

  getEventBridgeSource(http) {
    if (!_.has(http, 'source')) {
      return ''
    }

    if (http.source.pathParam) {
      return `$input.params().path.${http.source.pathParam}`
    }

    if (http.source.queryStringParam) {
      return `$input.params().querystring.${http.source.queryStringParam}`
    }

    if (http.source.bodyParam) {
      return `$util.parseJson($input.body).${http.source.bodyParam}`
    }

    return `${http.source}`
  }

  getEventBridgeDetailType(http) {
    if (!_.has(http, 'detailType')) {
      return '$context.requestId'
    }

    if (http.detailType.pathParam) {
      return `$input.params().path.${http.detailType.pathParam}`
    }

    if (http.detailType.queryStringParam) {
      return `$input.params().querystring.${http.detailType.queryStringParam}`
    }

    if (http.detailType.bodyParam) {
      return `$util.parseJson($input.body).${http.detailType.bodyParam}`
    }

    return `${http.detailType}`
  }

  getEventBridgeDetail(http) {
    if (!_.has(http, 'detail')) {
      return '$util.escapeJavaScript($input.body)'
    }

    if (http.detail.pathParam) {
      return `{"${http.detail.pathParam}": "$input.params().path.${http.detail.pathParam}"}`.replace(/\"/g, "\\\"")
    }

    if (http.detail.queryStringParam) {
      return `{"${http.detail.queryStringParam}": "$input.params().querystring.${http.detail.queryStringParam}"}`.replace(/\"/g, "\\\"")
    }

    if (http.detail.bodyParam) {
      return `$util.escapeJavaScript($util.parseJson($input.body).${http.detail.bodyParam})`
    }

    return '$util.escapeJavaScript($input.body)'
  }

  buildDefaultEventBridgeRequestTemplate(http) {
    const sourceParam = this.getEventBridgeSource(http)
    const detailTypeParam = this.getEventBridgeDetailType(http)
    const detailParam = this.getEventBridgeDetail(http)

    return {
      'Fn::Sub': [
        '{"Entries":[{"Detail": "${Detail}","DetailType": "${DetailType}","EventBusName": "${EventBusName}","Source": "${Source}"}]}',
        {
          EventBusName: http.eventBusName,
          Detail: `${detailParam}`,
          DetailType: `${detailTypeParam}`,
          Source: `${sourceParam}`
        }
      ]
    }
  }

  async mergeDeployment() {
    let exists = false
    Object.keys(this.serverless.service.provider.compiledCloudFormationTemplate.Resources).forEach(
      (resource) => {
        if (
          this.serverless.service.provider.compiledCloudFormationTemplate.Resources[resource][
            'Type'
          ] === 'AWS::ApiGateway::Deployment'
        ) {
          exists = true
          this.serverless.service.provider.compiledCloudFormationTemplate.Resources[resource][
            'DependsOn'
          ] = this.serverless.service.provider.compiledCloudFormationTemplate.Resources[resource][
            'DependsOn'
          ].concat(this.apiGatewayMethodLogicalIds)
        }
      }
    )

    if (!exists) {
      await this.compileDeployment()
    }
  }
}

module.exports = ServerlessPlugin;
