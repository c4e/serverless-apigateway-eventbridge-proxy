![Node.js Package](https://github.com/c4e/serverless-events-cross-organization/workflows/Node.js%20Package/badge.svg)
Serverless Eventbridge Cross Organization


--------------------------------

Add roles, rules, policies to send and receive events cross organization

Installation
-----
Install the package with npm: `npm install serverless-events-cross-organization`, and add it to your `serverless.yml` plugins list:

```yaml
plugins:
  - serverless-events-cross-organization
```

Usage
-----

```yaml
custom:
  eventBridgeCrossOrganization:
    sendEvents:
      - targetAccountId: "3045131172291"
        pattern:
          source: 
            - "company.service"
    receiveEvents:
      organizationId: "o-x09ij3ysgl"
```

| Parameter Name | Type | Description |
| --- | --- | --- |
| sendEvents | Array | List of accounts |
| pattern (required) | Object | Pattern to filter events |
| source (required) | Array | List of sources to filter |
| receiveEvents | Object | Options to allow receive events |
| organizationId (required) | String | Organization Id |