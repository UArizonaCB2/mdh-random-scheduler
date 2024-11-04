/*
 * Author: Shravan Aras <shravanaras@arizona.edu>
 * Project: EMA
 * Original Date: 01/2024
 * Major Update 2.0 Start: 10/2024
 */

const mdh = require('./mdh')
const secretManager = require('./SecretsManager')
const eventScheduler = require('./EventScheduler')
const {DateTime, Duration} = require('luxon')
require('dotenv').config()

// **NOTE!** In a real production app you would want these to be sourced from real environment variables. The .env file is just
// a convenience for development.
const rksProjectId = process.env.RKS_PROJECT_ID
const project_name = process.env.PROJECT_NAME
const roleArn = process.env.AWS_ROLE_ARN
const targetArn = process.env.AWS_TARGET_ARN

/* This is the ARN for the reminder notification sender. */
const reminderArn = process.env.AWS_REMINDER_ARN
const reminderIntervals = process.env.REMINDER_INTERVALS

// This is the AWS Event Group to which we need to add the schedules.
const eventGroup = process.env.AWS_EVENT_GROUP

/* Anchor times for the EMA solution. */
const times = ['10:12', '12:24', '14:36', '16:48', '19:00']
/* Random interval for the EMA solution. */
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
      Failed : []
    }
  }

  const participants = await mdh.getAllParticipants(token, rksProjectId)
  for (const participant of participants.participants) {
    if (participant.demographics.utcOffset == null)
      continue

    summaryLog.Participants.Parsed += 1

    /* Luxon date object of current date in participant local time zone. */
    const localTime_lux = getParticipantLocalTime(participant)
    /* Date (YYYY-MM-DD) till which the schedule has already been generated. */
    let generatedTill = getCustomField(participant, customFieldName)
    const notificationReady = getCustomField(participant, randomNotificationReady)

    /* IMPORTANT - Remove this when ready to deploy to production. */
    const debugParticipant = getCustomField(participant, 'V2Debug')
    if (debugParticipant != 'yes') {
      continue
    }
    /* End of development deployment block. */

    // Only move ahead if EMA notifications are enabled for the participant.
    /* IMPORTANT TODO: Uncomment this before pushing it to productions. */
    /*
      if (notificationReady != 'yes') {
        continue
      }
    */

    summaryLog.Participants.NotificationReady += 1

    /*
     * Construct a luxon DateTime object from generatedTill string in local participant timezone.
     */
    let generatedTill_lux = localTime_lux
    console.log(generatedTill)
    if (generatedTill != null && generatedTill != '') {
      generatedTill = generatedTill.trim()
      generatedTill_lux = DateTime.fromFormat(generatedTill, 'yyyy-MM-dd',
                                              {zone: getParticipantTimeZone(participant)})
    }

    let timeDiff_dur = localTime_lux.diff(generatedTill_lux) /* A Luxon Duration object. */
    if (generatedTill == null ||
        generatedTill == '' ||
        (timeDiff_dur.milliseconds / (1000 * 60 * 60)) > 24){
      summaryLog.Participants.MarkedForAddition += 1
      // Run the schedule, so we can create the random notification times.
      // An array containing Luxon.DateTime objects for the random schedule.
      const schedule_lux = makeRandomSchedule(participant, times, randomInterval, true)

      // Get the current time in UTC so we can skip any dates before that to keep AWS Scheduler happy.
      const currentUtc_lux = DateTime.utc()

      for (const utcTime_lux of schedule_lux) {
        // Silently ignore any dates that are older than the current date and don't add them.
        if (utcTime_lux > currentUtc_lux) {
          const res = await putScheduleEvent(participant.participantIdentifier, utcTime_lux)
          // Add the reminder events. If these fail we silently move on. Don't want to take
          // the whole system down just for reminders.
          await putReminderEvent(participant.participantIdentifier, utcTime_lux)
          if (res == null) {
            // TODO: Add to logs that schedule could not be created and do not update the MDH bits.
            summaryLog.Participants.Failed.push({
              ParticipantId : participant.participantIdentifier,
              RuleName : createRuleName(participant.participantIdentifier, utcTime_lux)
            })
          }
        }
      }
      // Add the new date to the participant custom field.
      let payload = {
        'id' : participant.id,
        'customFields' : {}
      }
      payload.customFields[customFieldName] = formatDate(localTime_lux)
      const response = await mdh.updateParticipant(token, rksProjectId, payload)

      /* TODO: Make sure to check the response to know if this
       * has been set for the user. If not raise an error in the logs.
       */
      console.log('Added schedule for participant '+participant.participantIdentifier+' for '+formatDate(localTime_lux)+'(local)')
      summaryLog.Participants.RulesAdded += 1
    }
    else {
      console.log('Participant '+participant.participantIdentifier+' already has schedule for '+formatDate(localTime_lux)+'(local)')
    }
  }

  console.log(JSON.stringify(summaryLog, null, 2))
}

/*
 * DEPRECIATED - Since we have moved to using EventScheduler from EventBridge rules.
 * Method which given a pid, deletes all the rules prior to the current date of the participant.
 */
async function deleteParticipantRules(participantId, currentDate) {
  throw new Error('Depreciated Method : deleteParticipantRules()')

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
 * Method which creates the event bridge event schedule and attaches the target lambda function to it.
 *
 * @param {string} participantId - Participants Identifier example MDH-...-.....
 * @param {luxon} utcDate - A luxon date object containing the UTC date for when to invoke the schedule.
 * @returns - not null value if the schedule was added successfully.
 */
async function putScheduleEvent(participantId, utcDate) {
  let schedule_name = createRuleName(participantId, utcDate)
  const params = {
    Name: schedule_name,
    Description: 'Automatic schedule generated for project '+project_name,
    GroupName: eventGroup,
    ScheduleExpression: 'cron('+utcDate.minute+' '+utcDate.hour+' '+utcDate.day+' '+utcDate.month+' ? '+utcDate.year+')', // (hh mm dom mon ? yyyy)
    FlexibleTimeWindow: {
      Mode: 'OFF',
    },
    State: 'ENABLED',
    Target: {
      Arn: targetArn,
      RoleArn: roleArn,
      Input: JSON.stringify({
        'pid': participantId,
      }),
    },
    Tags: [
      {Key: 'project', Value: project_name},
      {Key: 'Partcipant', Value: participantId}
    ],
    ActionAfterCompletion: 'DELETE',
  }

  let res = null
  // Add this to the AWS Event Scheduler.
  try {
    res = await eventScheduler.addSchedule(params)
  }
  catch (err) {
    console.log(err)
  }

  return res
}

/**
 * Method which creates the event bridge schedule for 5 and 15 minute reminders.
 */
async function putReminderEvent(participantId, utcDate) {
  // Split the reminder interval variable to get the various reminder intervals in minutes.
  let intervals = reminderIntervals.split(',')
  if (intervals.length <= 0) {
    console.log('Warning : Invalid interval string in environment variable')
    return
  }

  // Go ahead and clean up the interval strings and also change them into integers.
  try {
    for (let a=0; a < intervals.length; a++) {
      intervals[a] = parseInt(intervals[a].trim())
    }
  }
  catch(ex) {
    console.log(ex) // When a string cannot be converted into integer.
  }

  // For each interval we create a new schedule instance that will get added.
  for (let a=0;a < intervals.length;a++) {
    const reminderDate = utcDate.plus(Duration.fromObject({minutes:intervals[a]}))
    const scheduleName = createReminderName(participantId, reminderDate)

    const params = {
      Name: scheduleName,
      Description: 'Automatic reminder generated for project '+project_name,
      GroupName: eventGroup,
      ScheduleExpression: 'cron('+reminderDate.minute+' '+reminderDate.hour+' '+reminderDate.day+' '+reminderDate.month+' ? '+reminderDate.year+')', // (hh mm dom mon ? yyyy)
      FlexibleTimeWindow: {
        Mode: 'OFF',
      },
      State: 'ENABLED',
      Target: {
        Arn: reminderArn,
        RoleArn: roleArn,
        Input: JSON.stringify({
          'pid': participantId,
        }),
      },
      Tags: [
        {Key: 'project', Value: project_name},
        {Key: 'Partcipant', Value: participantId}
      ],
      ActionAfterCompletion: 'DELETE',
    }

    let res = null
    // Add this to the AWS Event Scheduler.
    try {
      res = await eventScheduler.addSchedule(params)
    }
    catch (err) {
      console.log(err)
    }
  }
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
 * Method to create rule name for the reminder notification
*/
function createReminderName(participantId, date) {
  return project_name + '_' + 'reminder' + '_' + participantId + '_' + formatDate(date) + '_' + date.hour + '_' + date.minute
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
  return date.get('year') + '-' + date.get('month') + '-' + date.get('day')
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
 * @returns {array[Luxon.DateTime]} - An array of random schedules for the participant for the current day in UTC.
 * */
function makeRandomSchedule(participant, times, randomInterval, logger=false) {
  let randomUTCTimes = []

  if (participant.demographics.timeZone == null)
    return []

  const today = getParticipantLocalTime(participant)

  let log = []
  for (const time of times) {
    const hh = Number.parseInt(time.split(':')[0])
    const min = Number.parseInt(time.split(':')[1])
    let rand = getRandom(1, randomInterval*2)
    /* The random interval in minutes that we need to add to the anchor points. */
    rand = (rand < randomInterval) ? -1 * rand : rand - randomInterval

    // Create a Luxon object for the anchor point for the current day (local time).
    const anchorTime_lux = DateTime.fromObject({
      year: today.get('year'),
      month: today.get('month'),
      day: today.get('day'),
      hour: hh,
      minute: min
    }, {
      zone : getParticipantTimeZone(participant)
    })

    // Add a duration object for the random minutes to this.
    const dt_dur = Duration.fromObject({
      minutes: rand
    })

    // Add the duration to the anchor data to create the new random time.
    const randTime_lux = anchorTime_lux.plus(dt_dur)

    // Convert the time back into UTC.
    utctime_lux = convToUTC(randTime_lux)
    log.push({'id': participant.participantIdentifier,
              'timeZone': getParticipantTimeZone(participant),
              'fixedLocalTime': anchorTime_lux.toLocaleString(DateTime.DATETIME_FULL),
              'randomLocalTime': randTime_lux.toLocaleString(DateTime.DATETIME_FULL),
              'randomUTCTime': utctime_lux.toLocaleString(DateTime.DATETIME_FULL),
              'randomOffsetMins': rand})

    randomUTCTimes.push(utctime_lux)
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
