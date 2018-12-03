const aws = require('aws-sdk');

const ecs = new aws.ECS({ apiVersion: '2014-11-13' });

function runECS(msg) {
  return new Promise((resolve, reject) => {
    const params = {
      taskDefinition: process.env.TASK_DEF,
      launchType: 'EC2',
      count: 1,
      cluster: process.env.CLUSTER,
      overrides: {
        containerOverrides: [{
          name: 'ECSTest',
          environment: [{
            name: 'CODE_REPO_URL',
            value: msg.url,
          },
          {
            name: 'CODE_REPO_HASH',
            value: msg.hash,
          },
          {
            name: 'CODE_REPO_STAGE',
            value: msg.stage,
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
    console.log(event.Records[0].Sns.Message.url);
    console.log(event.Records[0].Sns.Message.hash);
    console.log(event.Records[0].Sns.Message.stage);
    /* eslint-enable no-console */
  }

  return runECS(event.Records[0].Sns.Message);
};
