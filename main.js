const mdh = require('./mdh')
const eventBridge = require('./EventBridge')
const secretManager = require('./SecretsManager')
require('dotenv').config()

/*
 * TODO:
 */

// **NOTE!** In a real production app you would want these to be sourced from real environment variables. The .env file is just
// a convenience for development.
const rksProjectId = process.env.RKS_PROJECT_ID
const project_name = process.env.PROJECT_NAME
const roleArn = process.env.AWS_ROLE_ARN
const targetArn = process.env.AWS_TARGET_ARN

const times = ['10:12', '12:24', '14:36', '16:48', '19:00']
const randomInterval = 15
const customFieldName = 'scheduleGenerated'
const randomNotificationReady = 'randomNotificationReady'

async function main(args) {
  let rksServiceAccount = null
  let privateKey = null
  let rksProjectId = null

  const secretName = process.env.AWS_SECRET_NAME

  // If we are in production system then MDH configuration will get loaded from the secrets manager.
  if (process.env.NODE_ENV === 'production') {
    let secret = await secretManager.getSecret(secretName)
    secret = JSON.parse(secret)
    rksProjectId = secret['RKS_PROJECT_ID']
    rksServiceAccount = secret['RKS_SERVICE_ACCOUNT']
    privateKey = secret['RKS_PRIVATE_KEY']
  }
  else {
    // Local / Non-production environment.
    // If We have passed the service account and private key path in the environment use that.
    if (process.env.RKS_SERVICE_ACCOUNT && process.env.RKS_PRIVATE_KEY) {
      console.log('Using MDH credentials from environment variables')
      rksServiceAccount = process.env.RKS_SERVICE_ACCOUNT
      rksProjectId = process.env.RKS_PROJECT_ID
      privateKey = process.env.RKS_PRIVATE_KEY
    }
    else {
      console.log('Fatal Error: RKS service account and RKS private key must be set in env variables.')
      return null
    }
  }

  // Needed when passing and storing the keys in \n escaped single lines.
  privateKey = privateKey.replace(/\\n/g, '\n')

  const token = await mdh.getAccessToken(rksServiceAccount, privateKey)
  if(token == null) {
    return null
  }

  const participants = await mdh.getAllParticipants(token, rksProjectId)
  for (const participant of participants.participants) {
    if (participant.demographics.utcOffset == null)
      continue

    let localTime = getParticipantLocalTime(participant)
    let generatedTill = getCustomField(participant, customFieldName)
    let notificationReady = getCustomField(participant, randomNotificationReady)

    // Only move ahead if EMA notifications are enabled for the participant.
    if (notificationReady != 'yes') {
      continue
    }

    if (generatedTill == null || generatedTill.trim() != formatDateUTC(localTime)) {
      // Run the schedule, so we can create the random notification times.
      let schedule = makeRandomSchedule(participant, times, randomInterval)

      /* Create Event Bridge schedule to manage this on AWS. */
      for (const utcTime of schedule) {
        const res = await putScheduleEvent(participant.participantIdentifier, utcTime)
        console.log(res)
        if (res == null) {
          // TODO: Add to logs that schedule could not be created.
        }
      }
      // Add the new date to the participant custom field.
      let payload = {
        'id' : participant.id,
        'customFields' : {}
      }
      payload.customFields[customFieldName] = formatDateUTC(localTime)
      const response = await mdh.updateParticipant(token, rksProjectId, payload)
      /* TODO: Make sure to check the response to know if this
       * has been set for the user. If not raise an error in the logs.
       */
    }
    else {
      console.log('Participant '+participant.participantIdentifier+' already has schedule for '+formatDateUTC(localTime)+'(local)')
    }
  }
}

/*
 * Method which creates the event bridge schedule and attaches the target lambda function to it.
 */
async function putScheduleEvent(participantId, utcDate) {
  // Test out Event Bridge here.
  let schedule_name = project_name + '_' + participantId + '_' + formatDateUTC(utcDate) + '_' + utcDate.getUTCHours() + '_' + utcDate.getUTCMinutes()
  const params = {
    Name: schedule_name,
    Description: 'Automatic schedule generated for project '+project_name,
    ScheduleExpression: 'cron('+utcDate.getUTCMinutes()+' '+utcDate.getUTCHours()+' '+utcDate.getUTCDate()+' '+(utcDate.getUTCMonth()+1)+' ? '+utcDate.getUTCFullYear()+')', // (hh mm dom mon ? yyyy)
    State: 'ENABLED',
    Tags: [
      {Key: 'project', Value: project_name},
      {Key: 'Partcipant', Value: participantId}
    ],
   //RoleArn: roleArn,
  }

 const res = await eventBridge.addSchedule(params)
  // If the rule was created we will now go ahead and attach a target (lambda invoke) to it.
  if (res != null) {
    const target = {
      Rule: schedule_name,
      Targets: [
        {
          Arn: targetArn,
          Id: 'TargetLambdaFunction',
          Input: JSON.stringify({'pid': participantId})
        }
      ],
    }
    const tar = await eventBridge.addTarget(target)
  }

  return res
}

/*
 * Create a nice string of YYYY-MM-DD.
 * Writing my own so there is not automatic timezone conversion when using the library
 * string methods.
 * So if this runs on the servers, this will automatically be converted to localtime.
 * @params {Date} date - Date object to format.
 * @returns {stirng} Formatted string of the date YYYY-MM-DD
 */
function formatDateUTC(date) {
  return date.getUTCFullYear() + '-' + date.getUTCMonth() + '-' + date.getUTCDay()
}

/*
 * Get the specified custom field from the participant.
 * @param {object} participant - MDH participant object.
 * @param {string} fieldName - Name of the custom field.
 * @returns {string} value of the custom field if found, null otherwise.
 */
function getCustomField(participant, fieldName) {
  if (fieldName in participant.customFields) {
    return participant.customFields[fieldName]
  }

  return null
}

/*
 * Method which creates a random schedule for each participant for a single day
 * @param {object} participant - Object that contains all the participant information.
 * @param {array} times - A array of strings (hh:mm) around which the randomization will take place.
 * @param {int} randomInternal - The number of minutes around the actual time to create the random schedule.
 * */
function makeRandomSchedule(participant, times, randomInterval) {
  let randomUTCTimes = []

  if (participant.demographics.utcOffset == null)
    return []

  let minuteOffset = getPartcipantUTCOffset(participant)
  // Now let us get the current local time for this participant (saved in the object as UTC).
  let today = getParticipantLocalTime(participant)

  let year = today.getUTCFullYear()
  let month = today.getUTCMonth()
  let day = today.getUTCDay()

  let log = []
  for (const time of times) {
    let hh = time.split(':')[0]
    let min = time.split(':')[1]
    let rand = getRandom(1, randomInterval*2)
    rand = (rand < randomInterval) ? -1 * rand : rand - randomInterval

    // Passing .getTime() does not do any automatic timezone conversion.
    let ltime = new Date(today.getTime())
    // Convert it to midnight.
    ltime.setTime(ltime.getTime() - ltime.getUTCHours()*60*60*1000
                  - ltime.getUTCMinutes()*60*1000
                  - ltime.getUTCSeconds()*1000
                  - ltime.getUTCMilliseconds())
    // Add the hh:mm offset for the correct anchor point.
    ltime.setTime(ltime.getTime() + parseInt(hh)*60*60*1000 + parseInt(min)*60*1000)
    // For debug purposes what is the fixed local time (anchor)
    let fixedLocalTime = new Date(ltime.getTime())
    // Adjust the time with the random offset
    ltime.setTime(ltime.getTime() + rand*60*1000)
    // Convert the time back into UTC.
    utctime = convToUTC(ltime, minuteOffset)
    log.push({'id': participant.participantIdentifier,
                   'fixedLocalTime': fixedLocalTime.toUTCString(),
                   'randomLocalTime': ltime.toUTCString(),
                   'randomUTCTime': utctime.toUTCString(),
                   'randomOffsetMins': rand,
                   'utcOffset': minuteOffset})

    randomUTCTimes.push(utctime)
  }

  return randomUTCTimes
}

/* Get participant utc offset in minutes */
function getPartcipantUTCOffset(participant) {
  if (participant.demographics.utcOffset == null)
    return null

  let utcOffset = participant.demographics.utcOffset
  let buff = utcOffset.split(':')
  let minuteOffset = 0
  // Need to do a few extra things for the sign.
  if (parseInt(buff[0]) < 0) {
    minuteOffset = buff[0]*60 - buff[1]
  }
  else {
    minuteOffset = buff[0]*60 + buff[1]
  }

  return minuteOffset
}

/*
 * Method which returns the current local time for the participant.
 * @param {Object} participant - Object containing all the participant information.
 * @returns {DateTime} Current local date and time for the participant
 */
function getParticipantLocalTime(participant) {

  let minuteOffset = getPartcipantUTCOffset(participant)
  // Now let us get the current local time for this participant.
  let today = convToLocal(new Date(), minuteOffset)

  return today
}

/*
 * Method which returns a random number inclusive of the bounds.
 * @param {int} min
 * @param {int} max
 * @returns {int} random integer within the bounds.
 */
function getRandom(min, max) {
  return Math.floor(Math.random() * (max - min + 1) + min)
}

/*
 * Convert the given time from utc to local time.
 * @param {DateTime} utcTime - UTC Time
 * @param {int} utcOffset - UTC offset in minutes
 * @returns {DateTime} Local time.
 */
function convToLocal(utcTime, utcOffset) {
  time = new Date(utcTime.getTime())  // Using .getTime() avoids any automatic timezone conversions.
  time.setTime(time.getTime() + utcOffset*60*1000)

  return time
}

/*
 * Convert the given time from local to utc.
 * @param {DateTime} localTime - Local time
 * @param {int} utcOffset - UTC Offset
 * @returns {DateTime} UTC time
 */
function convToUTC(localTime, utcOffset) {
  return convToLocal(localTime, -1 * utcOffset)
}

exports.main = main
