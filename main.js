const mdh = require('./mdh')
const eventBridge = require('./EventBridge')
const secretManager = require('./SecretsManager')
const {DateTime, Duration} = require('luxon')
const fs = require('node:fs')
require('dotenv').config()

/*
 * TODO:
 * 1. Handle when sleep times are past midnight. For example - 01:00. These would need to be correct date adjusted.
 */

// **NOTE!** In a real production app you would want these to be sourced from real environment variables. The .env file is just
// a convenience for development.
const rksProjectId = process.env.RKS_PROJECT_ID
const project_name = process.env.PROJECT_NAME
const roleArn = process.env.AWS_ROLE_ARN
const targetArn = process.env.AWS_TARGET_ARN

const customFieldName = 'scheduleGenerated'
const randomNotificationReady = 'randomNotificationReady'

const customFields = {
  scheduleGenerated : 'scheduleGenerated',
  weekdayWakeTime : 'weekdayWakeTime',
  weekdaySleepTime : 'weekdaySleepTime',
  weekendWakeTime : 'weekendWakeTime',
  weekendSleepTime : 'weekendSleepTime',
  startDate : 'startDate'
}

const NEWLINE = '\n'

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

  // Object that logs the overall summary stats from this.
  let summaryLog = {
    Participants : {
      Parsed : 0,
      NotificationReady : 0,
      RulesAdded : 0,
      MarkedForAddition : 0,
      Failed : []
    },
    Deleted : {
      Marked : 0,
      Deleted : 0,
      Failed : []
    }
  }

  // Read in the supporting files needed.
  files = supportingFiles()

  const participants = await mdh.getAllParticipants(token, rksProjectId)
  for (const participant of participants.participants) {
    if (participant.demographics.timeZone == null)
      continue

    summaryLog.Participants.Parsed += 1

    let scheduleGenerated = getCustomField(participant, customFields.scheduleGenerated)
    let custStartDate = getCustomField(participant, customFields.startDate)
    // Parse this into luxon:DateTime with the participant timezone.
    let startDate = DateTime.fromISO(custStartDate).setZone(participant.demographics.timeZone)
    if (Number.isNaN(startDate.year)) {
      // There was an error parsing the format.
      logParticipantError(participant, 'Invalid ISO DateTime format for custom field startDate. Got '+custStartDate+ ' expected yyyy-mm-dd')
      continue
    }
    // Get the wake and sleep times and populate them.
    let wakesleep = populateWakeSleep(participant)

    makeRandomSchedule(participant, startDate, wakesleep, files.anchors, files.randomInterval, true)

    /*
      const res = await deleteParticipantRules(participant.participantIdentifier, formatDateUTC(localTime))
      summaryLog.Deleted.Marked += res.markedForDelete
      summaryLog.Deleted.Deleted += res.deleted
    */

    // Only move ahead if EMA notifications are enabled for the participant.
    notificationReady = 'no'
    if (notificationReady != 'yes') {
      continue
    }

    summaryLog.Participants.NotificationReady += 1

    if (generatedTill == null || generatedTill.trim() != formatDateUTC(localTime)) {
      summaryLog.Participants.MarkedForAddition += 1
      // Run the schedule, so we can create the random notification times.
      let schedule = makeRandomSchedule(participant, times, randomInterval)

      /* Create Event Bridge schedule to manage this on AWS. */


      for (const utcTime of schedule) {
        const res = await putScheduleEvent(participant.participantIdentifier, utcTime)
        if (res == null) {
          // TODO: Add to logs that schedule could not be created and do not update the MDH bits.
          summaryLog.Participants.Failed.push({
            ParticipantId : participant.participantIdentifier,
            RuleName : createRuleName(participant.participantIdentifier, utcTime)
          })
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
      console.log('Added schedule for participant '+participant.participantIdentifier+' for '+formatDateUTC(localTime)+'(local)')
      summaryLog.Participants.RulesAdded += 1
    }
    else {
      console.log('Participant '+participant.participantIdentifier+' already has schedule for '+formatDateUTC(localTime)+'(local)')
    }
  }

  console.log(JSON.stringify(summaryLog, null, 2))
}

/*
 * Populate wake and sleep times from custom fields.
 */
function populateWakeSleep(participant) {
  let wakesleep = {
    weekend : {
      wake: null,
      sleep: null,
    },
    weekday : {
      wake: null,
      sleep: null,
    }
  }

  wakesleep.weekday.wake = parseWSTime(getCustomField(participant, customFields.weekdayWakeTime))
  if (wakesleep.weekday.wake == null) {
    logParticipantError(participant, 'Invalid format for weekday wake time in custom field. Must be (hh:mm)')
  }
  wakesleep.weekday.sleep = parseWSTime(getCustomField(participant, customFields.weekdaySleepTime))
  if (wakesleep.weekday.sleep == null) {
    logParticipantError(participant, 'Invalid format for weekday sleep time in custom field. Must be (hh:mm)')
  }
  wakesleep.weekend.wake = parseWSTime(getCustomField(participant, customFields.weekendWakeTime))
  if (wakesleep.weekend.wake == null) {
    logParticipantError(participant, 'Invalid format for weekend wake time in custom field. Must be (hh:mm)')
  }
  wakesleep.weekend.sleep = parseWSTime(getCustomField(participant, customFields.weekendSleepTime))
  if (wakesleep.weekend.sleep == null) {
    logParticipantError(participant, 'Invalid format for weekend sleep time in custom field. Must be (hh:mm)')
  }

  return wakesleep
}

/*
 * Method which breaks down a time string of form (hh:mm) and converts it to a luxon:Duration
 * object with the participants local timezone.
 * @param {String} time - hh:mm format time.
 * @param {String} zone - time zone locale.
 * @returns {luxon:Duration} - In case of an error, null is returned.
 */
function parseWSTime(time) {
  let buff = time.split(':')
  if (buff.length < 2) {
    return null
  }

  try {
    let dt = Duration.fromObject({
      hours: Number.parseInt(buff[0]),
      minutes: Number.parseInt(buff[1])
    })

    return dt
  }
  catch (err) {
    return null
  }

  return null
}

/*
 * Method which console logs participant error.
 * @param {Object} participant - MDH participant object.
 * @returns {string} The error string generated.
 */
function logParticipantError(participant, message) {
  errorString = 'Error: ('+participant.participantIdentifier+') - '+message
  console.log(errorString)

  return errorString
}

/*
 * Method which reads the supporting files - offsets.csv, weekday.csv, weekend.csv
 * either from a specified S3 location or from the local code invocation location.
 * These are returned in `anchors` and `randomInterval`
 * Note - Small files, we can read them in memory fully, don't need streams.
 */
function supportingFiles(filenames = {offsets:'offsets.csv', weekday:'weekday.csv', weekend:'weekend.csv'}) {
  // Weekend files.
  let weekend_lines = splitLines(fs.readFileSync(filenames.weekend, 'utf8'))[0]
  let weekend = weekend_lines.split(',')
  weekend = trimUTFArray(weekend)
  // Weekday files.
  let weekday_lines = splitLines(fs.readFileSync(filenames.weekday, 'utf8'))[0]
  let weekday = weekday_lines.split(',')
  weekday = trimUTFArray(weekday)
  // Offset table or matrix.
  let offset_lines = splitLines(fs.readFileSync(filenames.offsets, 'utf8'))
  offsets = []
  for (const line of offset_lines) {
    offsets.push(trimUTFArray(line.split(',')))
  }

  return {
    anchors : {
      weekday : weekday,
      weekend : weekend
    },
    randomInterval : offsets
  }
}

/*
 * Given an array, it trims each element of the array.
 * All non-numeric strings are converted to NaN.
 */
function trimUTFArray(array) {
  for (let i=0; i < array.length; i++) {
    array[i] = array[i].trim()
    array[i] = Number.parseInt(array[i])
  }

  return array
}

/*
 * Wrapper method that returns lines as buffer
 */
function splitLines(buffer) {
  return buffer.trim().split(NEWLINE)
}

/*
 * Method which given a pid, deletes all the rules prior to the current date of the participant.
 */
async function deleteParticipantRules(participantId, currentDate) {
  throw new Error('Modify')
  const prefix = project_name + '_' + participantId
  let participantRules = await eventBridge.listRulesByPrefix(prefix)
  // Convert currentDate from string to a date object.
  const cd = new Date(currentDate)

  let markedForDelete = 0
  let deleted = 0
  let failed = []

  for (const rule of participantRules) {
    // Extract the date from the cron string.
    const scheduleExpression = rule.ScheduleExpression
    const dp = scheduleExpression.split('(')[1].split(')')[0].split(' ')
    const jobDate = new Date(dp[5]+'-'+dp[3]+'-'+dp[2])


    // If the cron job is older than the current time for the participant we need
    // to remove it.
    if (jobDate < cd) {
      console.log('Rule '+rule.Name+' falls before current date '+currentDate+'. Ready to delete.')
      markedForDelete += 1
      const delres = eventBridge.deleteRule(rule.Name)
      if (delres) {
        deleted += 1
      }
      else {
        failed.push(rule.Name)
      }
    }
  }

  return {
    markedForDelete : markedForDelete,
    deleted : deleted
  }
}

/*
 * Method which creates the event bridge schedule and attaches the target lambda function to it.
 */
async function putScheduleEvent(participantId, utcDate) {
  // Test out Event Bridge here.
  throw new Error('Modify')
  let schedule_name = createRuleName(participantId, utcDate)
  const params = {
    Name: schedule_name,
    Description: 'Automatic schedule generated for project '+project_name,
    ScheduleExpression: 'cron('+utcDate.getUTCMinutes()+' '+utcDate.getUTCHours()+' '+utcDate.getUTCDate()+' '+(utcDate.getUTCMonth()+1)+' ? '+utcDate.getUTCFullYear()+')', // (hh mm dom mon ? yyyy)
    State: 'ENABLED',
    Tags: [
      {Key: 'project', Value: project_name},
      {Key: 'Partcipant', Value: participantId}
    ],
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
 * Method which creates the rule name.
 * @param {string} participantId - MDH participant ID.
 * @param {luxon:DateTime} date - date to add to the rule name.
 * @returns {string} rule name
 */
function createRuleName(participantId, date) {
  return project_name + '_' + participantId + '_' + formatDate(date) + '_' + date.hour + '_' + date.minute
}

/*
 * Create a nice string of YYYY-MM-DD.
 * Writing my own so there is not automatic timezone conversion when using the library
 * string methods.
 * So if this runs on the servers, this will automatically be converted to localtime.
 * @params {luxon:DateTime} date - Date object to format.
 * @returns {stirng} Formatted string of the date YYYY-MM-DD
 */
function formatDate(date) {
  return date.year + '-' + date.month + '-' + date.day
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
 * Method which creates a random schedule for the participant for all 8 days (including the final morning)
 * @param {object} participant - Object that contains all the participant information.
 * @param {luxon:DateTime} startDate - Local timezone date when we want the EMA notifications to start for the
 *        participant
 * @param {object} wakesleep - {weekday:{wake:luxon:Duration, sleep:luxon:Duration}, weekend:{wake, sleep}}
 * @param {object} anchors - {weekday:[min, min,...], weekend:[min, min, ..]} Time anchor in minutes.
 * @param {array} randomInterval - m (days) x n (surveys) array of signed random offsets to add to anchor points in minutes.
 * */
function makeRandomSchedule(participant, startDate, wakesleep, anchors, randomInterval, logger=false) {
  let randomUTCTimes = []

  if (participant.demographics.timeZone == null)
    return []

  // Now let us get the current local time for this participant (saved in the object as UTC).
  let today = getParticipantLocalTime(participant)

  let log = []

  for (let day=0; day < randomInterval.length; day++) {
    let todayStart = startDate.plus(Duration.fromObject({days:day}))
    let todayEnd = startDate.plus(Duration.fromObject({days:day}))
    let todayAnchors = null

    // Check if this is the weekend (Sat, Sun) weekday of 6,7
    // and then adjust the start and end times accordingly based on wake and sleep
    if (todayStart.weekday == 6 || todayStart.weekday == 7) {
      todayStart = todayStart.plus(wakesleep.weekend.wake)
      todayEnd = todayEnd.plus(wakesleep.weekend.sleep)
      todayAnchors = anchors.weekend
    }
    else { // Weekday
      todayStart = todayStart.plus(wakesleep.weekday.wake)
      todayEnd = todayEnd.plus(wakesleep.weekday.sleep)
      todayAnchors = anchors.weekday
    }
    for (let survey=0; survey < randomInterval[day].length; survey++) {
      // If we need to a skip a particular delivery time, then this will be NaN in the interval table.
      if (Number.isNaN(randomInterval[day][survey])) {
        continue
      }
      let randomOffset = randomInterval[day][survey]
      let fixedLocalTime = null
      // Except for the last survey, all others are anchored from the wake up time.
      // dayStart/End +- surveyAnchor + randomOffset
      if (todayAnchors[survey] >= 0) {  // Positive anchors are offset from the day start.
        fixedLocalTime = todayStart.plus(Duration.fromObject({minutes:todayAnchors[survey]}))
      }
      else {  // A negative daily anchor is offsetted from the sleep time.
        fixedLocalTime = todayEnd.minus(Duration.fromObject({minutes:todayAnchors[survey]}))
      }
      // Add the pre-determined random offset for this (day, survey)
      let randomLocalTime = fixedLocalTime.plus(Duration.fromObject({minutes:randomInterval[day][survey]}))

      // Convert this to UTC and then add it to the scheduling array.
      let utcTime = convToUTC(randomLocalTime)
      randomUTCTimes.push(utcTime)
      log.push({'id': participant.participantIdentifier,
                'timeZone': participant.demographics.timeZone,
                'wakeUp' : todayStart.toLocaleString(DateTime.DATETIME_FULL),
                'sleep' : todayEnd.toLocaleString(DateTime.DATETIME_FULL),
                'fixedLocalTime': fixedLocalTime.toLocaleString(DateTime.DATETIME_FULL),
                'randomLocalTime': randomLocalTime.toLocaleString(DateTime.DATETIME_FULL),
                'randomUTCTime': utcTime.toLocaleString(DateTime.DATETIME_FULL),
                'randomOffsetMins': randomInterval[day][survey],
                'day_survey': day+','+survey})
    }
  }

  if (logger) {
    console.log(log)
  }

  return randomUTCTimes
}

/* Get participant utc offset in minutes */
/* DEPRECIATED - We have moved to timeZone locale now. */
function getPartcipantUTCOffset(participant) {
  throw new Error('Depreciated Method : getParticipantUTCOffset()')
}

/*
 * Method which returns the participant timeZone string.
 * @param {Object} participant - Object containing all the participant information.
 */
function getParticipantTimeZone(participant) {
  if (participant === null) {
    return null
  }

  return participant.demographics.timeZone
}

/*
 * Method which returns the current local time for the participant.
 * Makes use of the luxon library.
 * @param {Object} participant - Object containing all the participant information.
 * @returns {LuxonObject} Returns a luxon date object with local timeset.
 */
function getParticipantLocalTime(participant) {
  let timeZone = getParticipantTimeZone(participant)
  let today = DateTime.now().setZone(timeZone)

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
 * DEPRECIATED / UNUSED
 * Convert the given time from utc to local time.
 * @param {DateTime} utcTime - UTC Time
 * @param {int} utcOffset - UTC offset in minutes
 * @returns {DateTime} Local time.
 */
function convToLocal(utcTime, utcOffset) {
  throw new Error('Depreciated Method : convToLocal()')

  return time
}

/*
 * Convert the given time from local to utc.
 * @param {luxon:DateTime} localTime - Local time
 * @returns {luxon:DateTime} UTC time
 */
function convToUTC(localTime) {
  if (localTime === null) {
    return null
  }
  return localTime.toUTC()
}

exports.main = main
