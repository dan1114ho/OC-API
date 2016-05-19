var bodyParser = require('body-parser');
var config = require('config');
var cors = require('cors');
var errorhandler = require('errorhandler');
var morgan = require('morgan');
var multer = require('multer');
var passport = require('passport');
var GitHubStrategy = require('passport-github').Strategy;

module.exports = function(app) {

  // Body parser.
  app.use(bodyParser.json());
  app.use(bodyParser.urlencoded({ extended: true }));
  app.use(multer());

  // Cors.
  app.use(cors());

  // Logs.
  app.use(morgan('dev'));

  // Error handling.
  app.use(errorhandler());

  // Authentication
  const serviceCallback = (accessToken, refreshToken, profile, done) => done(null, accessToken, profile);

  passport.use(new GitHubStrategy(config.github, serviceCallback));

  // TODO add twitter etc strategies

  app.use(passport.initialize());
};
