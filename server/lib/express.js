var bodyParser = require('body-parser');
var config = require('config');
var cors = require('cors');
var morgan = require('morgan');
var multer = require('multer');
var passport = require('passport');
const session = require('express-session');
var GitHubStrategy = require('passport-github').Strategy;
const TwitterStrategy = require('passport-twitter').Strategy;

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
  if (process.env.NODE_ENV !== 'production' && process.env.NODE_ENV !== 'staging') {
    app.use(require('errorhandler')());
  }

  // Authentication

  passport.use(new GitHubStrategy(config.github,
    (accessToken, refreshToken, profile, done) => done(null, accessToken, { profile })));

  passport.use(new TwitterStrategy(Object.assign({}, config.twitter, {session: false}),
    (accessToken, tokenSecret, profile, done) => done(null, accessToken, { tokenSecret, profile })));

  // TODO if prod load ramps up, configure 'store' (default: MemoryStore)
  app.use(session({ secret: 'my_precious', resave: true }));
  app.use(passport.initialize());
};
