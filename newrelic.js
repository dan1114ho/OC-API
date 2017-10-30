/**
 * New Relic agent configuration.
 *
 * See lib/config.defaults.js in the agent distribution for a more complete
 * description of configuration variables and their potential values.
 */
export default {
  config: {
    /**
     * Array of application names.
     */
    app_name: ['OC API'],
    /**
     * Your New Relic license key.
     */
    license_key: '375d52f6c10eab6a34202b07fdd302ec4e10da13',
    logging: {
      /**
       * Level at which to log. 'trace' is most useful to New Relic when diagnosing
       * issues with the agent, 'info' and higher will impose the least overhead on
       * production applications.
       */
      level: 'info'
    }
  }
}