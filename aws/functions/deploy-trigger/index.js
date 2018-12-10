const AWS = require('aws-sdk');
const https = require('https');

const sns = new AWS.SNS({ apiVersion: '2010-03-31' });
const sm = new AWS.SecretsManager({ apiVersion: '2017-10-17' });

function getEnvs(yaml) {
  const pos = yaml.indexOf('environments:');
  if (pos > 0) {
    return yaml.substr(pos + 14).trim().replace(/-| /g, '').split(/\r?\n/);
  }
  return false;
}

function doRequest(options, postData) {
  return new Promise((resolve, reject) => {
    const buffers = [];
    const req = https.request(options, (res) => {
      res.on('data', (buffer) => {
        buffers.push(buffer);
      });

      res.on('end', () => {
        if (res.statusCode === 200 || res.statusCode === 201) {
          resolve(Buffer.concat(buffers).toString());
        } else {
          reject(Buffer.concat(buffers));
        }
      });
    }).on('error', (error) => {
      reject(error);
    });

    if (postData) {
      req.write(postData);
    }
    req.end();
  });
}

function getSM(name) {
  const params = {
    SecretId: name,
  };

  return sm.getSecretValue(params).promise();
}

exports.handler = async (event, context, callback) => {
  if (process.env.DEBUG) {
    // eslint-disable-next-line no-console
    console.log(event);
  }
  if (event.body != null) {
    const body = JSON.parse(event.body);

    if (body.deployment) {
      const params = {
        Message: JSON.stringify({
          remoteUrl: body.repository.clone_url,
          commitRef: body.deployment.ref,
          deploymentId: body.deployment.id,
          environment: body.deployment.environment,
        }),
        TopicArn: process.env.TOPIC,
      };

      // Create promise and SNS service object
      const publishTextPromise = sns.publish(params).promise();

      // Handle promise's fulfilled/rejected states
      await publishTextPromise.then((data) => {
        if (process.env.DEBUG) {
          // eslint-disable-next-line no-console
          console.log(`Message ${params.Message} sent to the topic ${params.TopicArn} with ID ${data.MessageId}`);
        }
        callback(null, { statusCode: 200, body: JSON.stringify({ msg: 'Deployment successfully started' }) });
      }).catch((err) => {
        if (process.env.DEBUG) {
          // eslint-disable-next-line no-console
          console.error(err, err.stack);
        }
        callback(null, { statusCode: 500, body: JSON.stringify({ error: 'Something went wrong...' }) });
      });
    } else if (body.hook && body.hook.type === 'Repository') {
      callback(null, { statusCode: 200, body: JSON.stringify({ msg: 'Test hook received' }) });
    } else if (body.repository || (body.remoteUrl && body.commitRef && body.environment)) {
      let owner = '';
      let repo = '';
      let branch = '';
      let gitToken = '';

      // depending on if this is direct from CLI or from hook, we need to do different parsing
      if (body.repository) {
        owner = body.repository.owner.login;
        repo = body.repository.name;
        branch = body.repository.default_branch;
      } else {
        const parts = body.remoteUrl.split('/');

        [,,, owner, repo] = parts;
        branch = body.commitRef;
      }

      const stackYamlOptions = {
        host: 'raw.githubusercontent.com',
        // eslint-disable-next-line prefer-template
        path: '/' + owner + '/' + repo + '/' + branch + '/stack.yaml',
        method: 'GET',
        headers: {
          'User-Agent': 'Project Furnace',
        },
      };


      try {
        gitToken = await getSM(process.env.FURNACE_INSTANCE.concat('/GitToken'));
        if (gitToken.SecretString) {
          stackYamlOptions.headers.Authorization = 'token '.concat(gitToken.SecretString);
        }
      } catch (e) {
        if (process.env.DEBUG) {
          // eslint-disable-next-line no-console
          console.log('Error fetching GIT token from Secrets Manager', e);
        }
      }

      if (process.env.DEBUG) {
        // eslint-disable-next-line no-console
        console.log(stackYamlOptions);
      }

      const stackYaml = await doRequest(stackYamlOptions);

      const environments = getEnvs(stackYaml);

      if (environments) {
        const deploymentData = { owner, repo, ref: 'master' };

        deploymentData.environment = (body.repository ? environments[0] : body.environment);

        const postData = JSON.stringify(deploymentData);

        const deploymentOptions = {
          host: 'api.github.com',
          // eslint-disable-next-line prefer-template
          path: '/repos/' + owner + '/' + repo + '/deployments',
          method: 'POST',
          headers: {
            Accept: 'application/vnd.github.v3+json',
            'Content-type': 'application/json',
            'Content-Length': postData.length,
            'User-Agent': 'Project Furnace',
          },
        };

        if (gitToken.SecretString) {
          deploymentOptions.headers.Authorization = 'Bearer '.concat(gitToken.SecretString);
        }

        await doRequest(deploymentOptions, postData);

        callback(null, { statusCode: 200, body: JSON.stringify({ msg: 'Deployment successfully triggered' }) });
      }
    }
    callback(null, { statusCode: 422, body: JSON.stringify({ error: 'Request is missing some parameter' }) });
  }
};
