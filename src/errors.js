'use strict';

/** An error whose message is safe and friendly enough to show to players. */
class GameError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'GameError';
    this.status = status;
  }
}

module.exports = { GameError };
