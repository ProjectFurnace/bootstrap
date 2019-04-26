const https = require('https');
const crypto = require('crypto');
const yaml = require('yamljs');
const {PubSub} = require('@google-cloud/pubsub');

const pubsub = new PubSub();

// Do HTTPS request
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

// Retrieve a secret from Key Vault
function getSecret(name) {
  return msRestAzure.loginWithAppServiceMSI({resource: 'https://vault.azure.net'}).then(credentials => {
    if (process.env.DEBUG)
      console.log('Got credentials for azure');
    const client = new KeyVault.KeyVaultClient(credentials);
    return client.getSecret('https://'.concat(process.env.FURNACE_INSTANCE, '-vault.vault.azure.net'), name, '');
  }).catch(err => {
    if (process.env.DEBUG)
      console.log('Error retrieving secret', err);
    return reject(err);
  });
}

// Verification function to check if it is actually GitHub who is POSTing here
async function verifyGitSecret(headers, stringBody) {
  if (process.env.DEBUG) {
    // eslint-disable-next-line no-console
    console.log('verifying git secret...');
  }
  if (headers['x-hub-signature']) {
    // Get secret from secret store
    const gitSecret = await getSecret('GitHookSecret');
    if (gitSecret.value) {
      try {
        const signature = `sha1=${crypto.createHmac('sha1', gitSecret.value).update(stringBody).digest('hex')}`;
        return crypto.timingSafeEqual(Buffer.from(headers['x-hub-signature']), Buffer.from(signature));
      } catch (e) {
        return false;
      }
    }
  }
  return false;
}

// Verification function to check if the CLI request has the right API Key
async function verifyApiKey(headers) {
  if (process.env.DEBUG) {
    // eslint-disable-next-line no-console
    console.log('verifying api key...');
  }
  if (headers['x-api-key']) {
    // Get secret from secret store
    const apiKey = await getSecret('ApiKey');
    if (apiKey.value === headers['x-api-key']) {
      return true;
    }
  }
  return false;
}

exports.handler = async (request, response) => {
    // if debug is enabled, show the full received request
    if (process.env.DEBUG) {
      // eslint-disable-next-line no-console
      console.log(request);
    }
    // check if we have body property for the received request
    if (request.body != null) {
      const body = request.body;
  
      if (body.deployment) {
        // first let's validate the github signature
        if (!await verifyGitSecret(request.headers, request.rawBody)) {
          response.status(403).send(JSON.stringify({ msg: 'Github signature validation failed' }));
          return;
        }
  
        // send message to queue
        const event  = {
            remoteUrl: body.repository.clone_url,
            commitRef: body.deployment.ref,
            deploymentId: body.deployment.id,
            environment: body.deployment.environment,
        };
  
        const dataBuffer = Buffer.from(JSON.stringify(event), 'utf-8');

        // Publishes the message and prints the messageID on console
        const messageId = pubsub.topic(topicName).publish(dataBuffer);

        if (messageId) {
          // eslint-disable-next-line no-console
          if (process.env.DEBUG)
            console.log(`Message ${messageId} published`);
          response.status(200).send(JSON.stringify({ msg: 'Deployment successfully started' }));
        } else {
          response.status(500).send(JSON.stringify({ error: 'Something went wrong...' }));
        }
      // this is just a test hook from github
      } else if (body.hook && body.hook.type === 'Repository') {
        if (await verifyGitSecret(request.headers, request.rawBody)) {
          response.status(200).send(JSON.stringify({ msg: 'Github test hook received' }));
        } else {
          response.status(403).send(JSON.stringify({ msg: 'Github signature validation failed' }));
        }
        return;
      } else if (body.repository || (body.remoteUrl && body.commitRef && body.environment)) {
        let owner = '';
        let repo = '';
        let branch = '';
        let gitToken = '';
  
        // depending on if this is direct from CLI or from hook, we need to do different parsing
        // first option is github hook
        if (body.repository) {
          // first let's validate the github signature
          if (!await verifyGitSecret(request.headers, request.rawBody)) {
            response.status(403).send(JSON.stringify({ msg: 'Github signature validation failed' }));
            return;
          }
          owner = body.repository.owner.login;
          repo = body.repository.name;
          branch = body.repository.default_branch;
        } else {
          if (!await verifyApiKey(request.headers)) {
            response.status(403).send(JSON.stringify({ msg: 'API KEY validation failed' }));
            return;
          }
  
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
          gitToken = await getSecret('GitToken');
          if (gitToken.value) {
            stackYamlOptions.headers.Authorization = 'token '.concat(gitToken.value);
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
  
        // parse stack.yaml file
        const stackYaml = await doRequest(stackYamlOptions);
        const stack = yaml.parse(stackYaml);
        const { environments } = stack;
  
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
  
          if (gitToken.value) {
            deploymentOptions.headers.Authorization = 'Bearer '.concat(gitToken.value);
          }
  
          await doRequest(deploymentOptions, postData);
  
          response.status(200).send(JSON.stringify({ msg: 'Deployment successfully triggered' }));
        }
      }
      response.status(422).send(JSON.stringify({ error: 'Request is missing some parameter' }));
    }
};
