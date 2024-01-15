import {main} from './main.js'

export const handler = async (event, context) => {
  return main(event)
};

// Only need this if it is running in non-production environment.
if (process.env.NODE_ENV !== 'production') {
  handler(null)
}
