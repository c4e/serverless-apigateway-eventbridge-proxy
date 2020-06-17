Serverless Eventbridge Cross Organization

--------------------------------

This Serverless Framewrok plugin supports the AWS EventBridge proxy integration feature of API Gateway.

Installation
-----
Install the package with npm: `npm install serverless-apigateway-eventbridge-proxy`, and add it to your `serverless.yml` plugins list:

```yaml
plugins:
  - serverless-apigateway-eventbridge-proxy
```

Usage
-----

```yaml
custom:
  apiGatewayEventbridgeProxies:
    - path: /eventbridge
      method: post
      source: 'hardcoded_source'
      detailType: 'hardcoded_detailType'
      eventBusName: 'default'
```

Sample request after deploying.

```bash
curl https://company/eventbridge?detailType=type -d '{"message": "some data"}'  -H 'Content-Type:application/json'
```