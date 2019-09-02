const aws = require('aws-sdk');

const ecs = new aws.ECS({ apiVersion: '2014-11-13' });

function runECS(event) {
  const msg = JSON.parse(event);

  if (process.env.DEBUG) {
    /* eslint-disable no-console */
    console.log(msg);
  }

  return new Promise((resolve, reject) => {
    const params = {
      taskDefinition: process.env.TASK_DEFINITION,
      launchType: 'EC2',
      count: 1,
      cluster: process.env.CLUSTER,
      overrides: {
        containerOverrides: [{
          name: process.env.CONTAINER_NAME,
          environment: [{
            name: 'GIT_REMOTE',
            value: msg.remoteUrl,
          },
          {
            name: 'GIT_TAG',
            value: msg.commitRef,
          },
          {
            name: 'STACK_ENV',
            value: msg.environment,
          },
          {
            name: 'GIT_USERNAME',
            value: process.env.GIT_USERNAME,
          },
          {
            name: 'PLATFORM',
            value: process.env.PLATFORM,
          },
          {
            name: 'DEPLOYMENT_ID',
            value: msg.deploymentId.toString(),
          },
          {
            name: 'FURNACE_INSTANCE',
            value: process.env.FURNACE_INSTANCE,
          },
          {
            name: 'BUILD_BUCKET',
            value: process.env.BUILD_BUCKET,
          },
          {
            name: 'FN_TEMPLATES_TAG',
            value: process.env.FN_TEMPLATES_TAG,
          },
          {
            name: 'SOPS_KMS_ARN',
            value: process.env.SOPS_KMS_ARN,
          }],
        }],
      },
    };
    ecs.runTask(params, (err, data) => {
      if (err) {
        reject('Error while starting task:'.concat(err));
      } else {
        resolve('Task ECSTask started: '.concat(JSON.stringify(data.tasks)));
      }
    });
  });
}

exports.handler = async (event) => {
  if (process.env.DEBUG) {
    /* eslint-disable no-console */
    console.log(event.Records[0].Sns);
  }
  return runECS(event.Records[0].Sns.Message);
};
