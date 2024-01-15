const {
  SecretsManagerClient,
  GetSecretValueCommand,
} = require("@aws-sdk/client-secrets-manager");
const util = require("util")

/*
 * Method which retrieves the secret from the Secrets Manager.
 * @params {string} secretName - The name of the secret to retrieve.
 */
async function getSecret(secretName) {
  let secretValue = null

  const client = new SecretsManagerClient({
    region: "us-east-1",
  });

  const command = new GetSecretValueCommand({
    SecretId: secretName,
    VersionStage: "AWSCURRENT",
  })

  await client.send(command).then(data => {
    secretValue = data.SecretString
  }).catch(err => {
    logResponse(err)
  })

  return secretValue
}

function logResponse(response) {
  console.log(util.inspect(response, { colors: true, depth: 3 }));
}

exports.getSecret = getSecret
