/**
 * Dependencies.
 */
const Paypal = require('paypal-adaptive');
const knox = require('knox');
const config = require('config');
const nodemailer = require('nodemailer');
const Promise = require('bluebird');

/**
 * Module.
 */
module.exports = function(app) {
  const env = config.env;

  // Stripe.
  app.stripe = require('stripe')(config.stripe.secret);

  // Paypal.
  app.paypalAdaptive = new Paypal({
    userId: config.paypal.classic.userId,
    password: config.paypal.classic.password,
    signature: config.paypal.classic.signature,
    appId: config.paypal.classic.appId,
    sandbox: env !== 'production'
  });

  // S3 bucket
  app.knox = knox.createClient({
    key: config.aws.s3.key,
    secret: config.aws.s3.secret,
    bucket: config.aws.s3.bucket,
    region: 'us-west-1'
  });

  // Mailgun.
  if (config.mailgun.user) {
    app.mailgun = nodemailer.createTransport({
      service: 'Mailgun',
      auth: {
        user: config.mailgun.user,
        pass: config.mailgun.password
      }
    });
    app.mailgun.sendMail =  Promise.promisify(app.mailgun.sendMail, app.mailgun);
  } else {
    console.warn("Mailgun is not configured");
    app.mailgun = {
      sendMail: () => Promise.resolve()
    };
  }
};
