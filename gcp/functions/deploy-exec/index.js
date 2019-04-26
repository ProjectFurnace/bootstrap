const util = require("util")
    ;

exports.handler = async (context, eventInput) => {
  context.log("got event", eventInput);

  if (!eventInput.remoteUrl || !eventInput.commitRef) {
    context.done(new Error("remoteUrl and commitRef must be sent in the event input"));
    return;
  }

  const credentials = await MsRest.loginWithAppServiceMSI();
  context.log("got credentials", util.inspect(credentials, { depth: null }));

  const tokenResult = await axios({
    url: `${credentials.msiEndpoint}?resource=${credentials.resource}&api-version=${credentials.msiApiVersion}`,
    headers: { "Secret": credentials.msiSecret }
  });

  if (!tokenResult.data.access_token) {
    context.done(new Error("unable to get access token"));
    return;
  }

  const accessToken = tokenResult.data.access_token
      , subscriptionId = "836eaf85-82b8-4c2d-a4d1-2082104c7362"
      , resourceGroupName = "feasterrg"
      , containerGroupName = "dannytest1"
      , containerUrl = `/resourceGroups/${resourceGroupName}/providers/Microsoft.ContainerInstance/containerGroups/${containerGroupName}?api-version=2018-10-01`
      , identityName = "FurnaceDeployUserIdentity"
      , userIdArn = `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroupName}/providers/Microsoft.ManagedIdentity/userAssignedIdentities/${identityName}`
      ;

  const containerGroupDep = {
    type: "Microsoft.ContainerInstance/containerGroups",
    location: "westus",
    identity: {
      type: "UserAssigned",
      userAssignedIdentities: {
        [userIdArn]: {}
      }
    },
    properties: {
      containers: [
        {
          name: "furnace-deploy-container",
          properties: {
            environmentVariables: [
              { name: "GIT_REMOTE", value: eventInput.remoteUrl },
              { name: "GIT_TAG", value: eventInput.commitRef },
              { name: "GIT_USERNAME", value: "unset" },
              { name: "STACK_ENV", value: eventInput.environment },
              { name: "STACK_REGION", value: "WestUS" },
              { name: "ARM_USE_MSI", value: "true" },
              { name: "DEPLOYMENT_ID", value: eventInput.deploymentId.toString() },
              { name: "PLATFORM", value: process.env.PLATFORM },
              { name: "BUILD_BUCKET", value: process.env.BUILD_BUCKET },
              { name: "FURNACE_INSTANCE", value: process.env.FURNACE_INSTANCE }
            ],
            image: eventInput.image || "dannywaite/deploy:latest",
            resources: {
              requests: {
                memoryInGB: "1.5",
                cpu: 1
              }
            }
          }
        }
      ],
      imageRegistryCredentials: [],
      osType: "Linux",
      volumes: [],
      restartPolicy: "Never"
    }
  }
  
  try {
    
    const httpClient = getHttpClient(`https://management.azure.com/subscriptions/${subscriptionId}`, accessToken);
    const result = await httpClient.put(containerUrl, containerGroupDep);
    
    context.log(util.inspect(result.data, { depth: null }));
    context.done();
  } catch (err) {
    if (err.response) {
      context.log(util.inspect(err.response, { depth: null }));
    } else {
      context.log(util.inspect(err, { depth: null }));
    } 
    context.done(new Error("unable to start deployment container"));
  }
}

function getHttpClient(baseURL, accessToken) {
  return axios.create({
    baseURL,
    headers: {
      "authorization": "Bearer " + accessToken,
      "content-type": "application/json"
    }
  });
}