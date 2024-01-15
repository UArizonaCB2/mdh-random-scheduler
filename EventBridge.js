const {
  EventBridgeClient,
  PutRuleCommand,
  PutTargetsCommand
} = require('@aws-sdk/client-eventbridge')
const util = require('util')

/*
 * Method which adds a new schedule to event bridge
 */
async function addSchedule(params) {
  const ebclient = new EventBridgeClient({
    region: 'us-east-1'
  })

  let ruleArn = null

  const putRuleCommand = new PutRuleCommand(params)
  await ebclient.send(putRuleCommand).then(data => {
    ruleArn = data.RuleArn
  }).catch(err => {
    logResponse(err)
  })

  return ruleArn
}

/*
 * Method which adds a target to a rule.
 */
async function addTarget(params) {
  const ebclient = new EventBridgeClient({
    region: 'us-east-1'
  })

  let targetArn = null

  const putTargetsCommand = new PutTargetsCommand(params)
  await ebclient.send(putTargetsCommand).then(data => {
    /* Nothing returned is for any real value. */
  }).catch(err => {
    logResponse(err)
  })

  return targetArn
}

function logResponse(response) {
  console.log(util.inspect(response, { colors: true, depth: 3 }));
}

exports.addSchedule = addSchedule
exports.addTarget = addTarget
