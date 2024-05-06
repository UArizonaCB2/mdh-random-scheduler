const {
  SchedulerClient,
  CreateScheduleCommand
} = require('@aws-sdk/client-scheduler')

// For debugging we want to read from the local env file.
require('dotenv').config()

const roleARN = process.env.AWS_ROLE_ARN
const targetARN = process.env.AWS_TARGET_ARN

async function addSchedule(params) {
  const client = new SchedulerClient({
    region: 'us-east-1'
  })

  const command = new CreateScheduleCommand(params)
  const response = await client.send(command)

  return response
}

const params = {
  Name: 'mytestrule',
  ScheduleExpression: 'rate(5 minutes)',
  FlexibleTimeWindow: {
    Mode: 'OFF',
  },
  Target: {
    Arn: targetARN,
    RoleArn: roleARN,
  }
}
