#!/usr/bin/env bash

set -e

# Only run migrations automatically on staging and production
if [ "$SEQUELIZE_ENV" = "staging" ] || [ "$SEQUELIZE_ENV" = "production" ]; then
  npm run db:migrate
else

  if command -v psql > /dev/null; then
    echo "✓ Postgres installed"
  else
    echo "𐄂 command psql doesn't exist. Make sure you have Postgres installed (brew install postgres)"
  fi

  if [ ! -f .env ]; then
      echo "✓ .env not found, copying .env.default to .env"
      cp .env.default .env
  fi

  if [ ! "$NODE_ENV" = "circleci" ]; then
    if psql -lqt | cut -d \| -f 1 | grep -qw opencollective_dvl; then
      echo "✓ opencollective_dvl exists, running migration if any"
      PG_DATABASE=opencollective_dvl npm run db:migrate:dev
    else
      echo "> Restoring opencollective_dvl";
      ./scripts/db_restore.sh -d opencollective_dvl -f test/dbdumps/opencollective_dvl.pgsql
    fi
  else
    echo "✓ opencollective_dvl exists, running migration if any"
    npm run db:setup
    npm run db:migrate
  fi

  echo ""
  echo "You can now start the open collective api server by running:"
  echo "$> npm run dev"
  echo ""

fi
