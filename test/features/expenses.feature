Feature: Pay expenses in kind

  Background:
    Given a Host "Open Collective" in "USD" and charges "10%" of fee

  Scenario: Create a donation expense but don't approve it
    Given a Collective "Webpack" in "USD" hosted by "Open Collective"
    And a User "Jane"
    When "Jane" expenses "50 USD" for "Pizza" to "Webpack" via "Donation"
    Then "Jane" should have contributed "0 USD" to "Webpack"

  Scenario: Approve a newly created donation expense
    Given a Collective "Buttercup" in "USD" hosted by "Open Collective"
    And a User "Chen"
    When "Chen" expenses "50 USD" for "Pizza" to "Buttercup" via "Donation"
    And expense for "Pizza" is approved by "Buttercup"
    And expense for "Pizza" is paid by "Buttercup" with "0%" fee
    Then "Chen" should have contributed "50 USD" to "Buttercup"
    And "Buttercup" should have "0 USD" in their balance
