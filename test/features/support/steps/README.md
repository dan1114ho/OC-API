# Steps

The **steps** available in a *BDD* setup define what tests can be
written. This directory contains steps for multiple scenarios. They're
loosely grouped by what feature they're related to. Constant
refactoring might be needed here.

## 0

This is our canary test. If this test doesn't run, the test system is
most likely broken.

## setup

 * `Before`: Reset test database. It uses the `sequelize.sync()`
   function to get the DB into a clean slate before each scenario.

 * `AfterAll`: Closes the database connection so cucumber doesn't get
   the node process stuck. We could also just call cucumber with
   `--exit` but closing the database allows us to know when code that
   would actually leak an asynchronous call is added.

## users-and-collectives

 * `Given a User {name}`: Creates a new user and stores the database
   instance with the key `<name>` in the world.

 * `Given a Collective {name} with a host in {currency}`: Create a
   host collective with a certain and a collective. And set the host
   currency to `<currency>`. Changes to the world: Add collective
   under key `<name>`, add host collective as `<name>-host`, and add
   the host owner as `<name>-hostOwner`.

 * `Given a Collective {name} with a host in {currency}, {fee%} fee`:
   Same as above but also sets the host fee percentage.

 * `Given {hostCollective} connects a {paymentProcessor} account`:
   Create a connected account for a host collective with the payment
   provider name informed in `<paymentProcessor>`.

 * `Given {payemntProcessor} payment processor fee is {fee%}`: Set the
   fee of a payment processor.

 * `Given platform fee is {fee}`: Set the platform fee (how much Open
   Collective) charges per transaction.

 * `When {name} donates {value} to {collective} via {paymentMethod}`:
   This **action** creates and executes a one time order from the user
   `<name>` to the `<collective>`. The value of the transactions is
   specified in `<value>` and uses the format `AMOUNT CURRENCY`. E.g.:
   `10 USD`. The `<paymentMethod>` is a string containing `stripe` for
   now.

 * `Then {name} should have contributed {value} to {collective}`: This
   **assertion** checks if a user `<name>` contributed a certain
   amount to a collective. The `<value>` field is a string that
   contains amount and currency. e.g.: `10 USD`.

 * `Then {collective} should have {value} in their balance`: This
   asserts that a given collective has a certain value in their
   balance.

# expenses

 * `When {name} expenses {value} for {description} to {collective} via {method}`:
   This **action** creates an expense from the user `<name>` to the
   collective. The `<value>` is how much the expense is worth. It
   contains amount and currency.  e.g.: `10 USD`. The `<method>` must
   be a valid payout method.

 * `When expense for {description} is approved by {collective}`: The
   expense that was previously created with the same `<description>`
   is approved by the `<collective>`.

 * `When expense for {description} is paid by {collective} with {fee} fee`:
   The expense that was previously created with the same
   `<description>` is marked as paid by the `<collective>`. The
   `<fee>` can be expressed as a percentage of the total of the
   expense (when the sign [%] is present in the end of the
   string. Otherwise it will just use the input as the absolute value.
