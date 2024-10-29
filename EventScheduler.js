const {
  SchedulerClient,
  CreateScheduleCommand
} = require('@aws-sdk/client-scheduler')

// For debugging we want to read from the local env file.
require('dotenv').config()

async function addSchedule(params) {
  const client = new SchedulerClient({
    region: 'us-east-1'  // This is going to come back to bite us.
  })

  const command = new CreateScheduleCommand(params)
  const response = await client.send(command)

  return response
}

exports.addSchedule = addSchedule

/* Internal method used for testing. */
function moduleTest() {
  const roleARN = process.env.AWS_ROLE_ARN
  const targetARN = process.env.AWS_TARGET_ARN
  /* Example params we can use the event scheduler. */
  const params = {
    Name: 'mytestrule',
    GroupName: 'ymap',
    ScheduleExpression: 'rate(5 minutes)',
    FlexibleTimeWindow: {
      Mode: 'OFF',
    },
    Target: {
      Arn: targetARN,
      RoleArn: roleARN,
    },
    ActionAfterCompletion: 'DELETE',
  }

  const rest = addSchedule(params)
}
