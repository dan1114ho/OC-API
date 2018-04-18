if (!process.env.NODE_ENV) {
  process.env.NODE_ENV = 'development';
}

if (process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'docker') {
  const dotenv = require('dotenv');
  dotenv.config(); // this loads .env with real values. It needs to be first because dotenv doesn't overwrite any values
  dotenv.config({path: 'default.env'}); // this loads the default file in github with dummy values
}
