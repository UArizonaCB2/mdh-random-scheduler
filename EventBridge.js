const {
  EventBridgeClient,
  PutRuleCommand,
  PutTargetsCommand,
  ListRulesCommand,
  ListTargetsByRuleCommand,
  DeleteRuleCommand,
  RemoveTargetsCommand
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

/*
 * Method which returns a list of all the rules for a given
 * participant using prefix matching.
 */
async function listRulesByPrefix(prefix) {
  const ebclient = new EventBridgeClient({
    region: 'us-east-1'
  })

  const params = {
    NamePrefix: prefix
  }

  let ruleList = null
  const listRulesCommand = new ListRulesCommand(params)
  await ebclient.send(listRulesCommand).then(data => {
    ruleList = data.Rules
  }).catch(err => {
    logResponse(err)
  })

  return ruleList
}

/*
 * Method which deletes the specified rule.
 * Cannot be used to delete a managed rule (created by an AWS service on my behalf) as we
 * do not set the Force parameter in the request.
 *
 * @params {string} name Name of the rule.
 * @returns {boolean} True if the rule was deleted, False otherwise.
 */
async function deleteRule(name) {
  let status = false
  const ebclient = new EventBridgeClient({
    region: 'us-east-1'
  })

  // Need to make sure that all the targets associated with this rule
  // are first deleted.
  const targets = await listTargets(name)
  if (targets != null && targets.length > 0) {
    let targetIds = []
    for (const target of targets) {
      targetIds.push(target.Id)
    }
    const res = await deleteTargets(name, targetIds)
  }

  const params = {
    Name: name
  }

  const deleteCommand = new DeleteRuleCommand(params)
  await ebclient.send(deleteCommand).then(data => {
    status = true
  }).catch(err => {
    status = false
    logResponse(err)
  })

  return status
}

/*
 * Method which deletes a target from a rule.
 * This is required to delete a rule. Only rules with
 * empty targets can be deleted.
 *
 * @params {string} name Name of the rule.
 * @params {array} ids An array of target Ids associated with this rule. (max of 100)
 * @returns {object} Contains the faileEntries and FailedEntryCount if error. Or 0 otherwise.
 */
async function deleteTargets(name, ids) {
  const ebclient = new EventBridgeClient({
    region: 'us-east-1'
  })

  const params = {
    Rule: name,
    Ids: ids
  }

  let response = null
  const removeTargetCommand = new RemoveTargetsCommand(params)
  await ebclient.send(removeTargetCommand).then(data => {
    console.log(data)
    response = data
  }).catch(err => {
    logResponse(err)
  })

  return response
}

/*
 * Method which returns all the targets associated with a rule.
 *
 * @param {string} name Name of the rule.
 * @returns {array} targets Targets associated with the rule. Null in case of error.
 */
async function listTargets(name) {
  const ebclient = new EventBridgeClient({
    region: 'us-east-1'
  })

  const params = {
    Rule: name
  }

  let targetList = null
  const targetsCommand = new ListTargetsByRuleCommand(params)
  await ebclient.send(targetsCommand).then(data => {
    targetList = data.Targets
  }).catch(err => {
    logResponse(err)
  })

  return targetList
}

function logResponse(response) {
  console.log(util.inspect(response, { colors: true, depth: 3 }));
}

exports.addSchedule = addSchedule
exports.addTarget = addTarget
exports.listRulesByPrefix = listRulesByPrefix
exports.listTargets = listTargets
exports.deleteRule = deleteRule
