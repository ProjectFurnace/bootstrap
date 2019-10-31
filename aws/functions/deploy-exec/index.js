const aws = require('aws-sdk');

const codebuild = new aws.CodeBuild({ apiVersion: '2016-10-06' });

function runBuild(event) {
  const msg = JSON.parse(event);

  if (process.env.DEBUG) {
    /* eslint-disable no-console */
    console.log(msg);
  }

  return new Promise((resolve, reject) => {
    const params = {
      projectName: process.env.FURNACE_INSTANCE + '-updateStack',
      environmentVariablesOverride: [
        {
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
          name: 'DEPLOYMENT_ID',
          value: msg.deploymentId.toString(),
        },
      ],
    };
    // codebuild is not happy if we push empty env vars
    if (process.env.FN_TEMPLATES_TAG && process.env.FN_TEMPLATES_TAG !== '') {
      params.environmentVariablesOverride.push({
        name: 'FN_TEMPLATES_TAG',
        value: process.env.FN_TEMPLATES_TAG,
      });
    }
    codebuild.startBuild(params, (err, data) => {
      if (err) {
        reject('Error while starting build:'.concat(err));
      } else {
        resolve('Build started: '.concat(JSON.stringify(data.tasks)));
      }
    });
  });
}

exports.handler = async (event) => {
  if (process.env.DEBUG) {
    /* eslint-disable no-console */
    console.log(event.Records[0].Sns);
  }
  return runBuild(event.Records[0].Sns.Message);
};
