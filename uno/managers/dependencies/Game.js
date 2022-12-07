const pgp = require("pg-promise");
const db = require("../../db");
const ApiClientError = require("../../errors/ApiClientError");

class Game {
  constructor(id) {
    this.id = id;
    this.connectedSockets = {};
    this.deleted = false;
  }

  async connect(socket) {
    this.connectedSockets[socket.id] = socket;
    socket.on("disconnect", (reason) => {
      delete this.connectedSockets[socket.id];
      this.emitGameEvent({ type: "USER_DISCONNECTED", user_id: socket.request.session.passport.user.user_id, username: socket.request.session.passport.user.username });
      console.log(`[Game ${this.id}] Removed socket ID ${socket.id} (${reason}). # of connected sockets: ${Object.keys(this.connectedSockets).length}`);
    });
    console.log(`[Game ${this.id}] Added socket ID ${socket.id}, established by user ${socket.request.session.passport.user.username}. # of connected sockets: ${Object.keys(this.connectedSockets).length}`);

    socket.emit("game_state", await this.getGameStateForUser(socket.request.session.passport.user.user_id));

    this.emitGameEvent({ type: "USER_CONNECTED", user_id: socket.request.session.passport.user.user_id, username: socket.request.session.passport.user.username });
  }

  /**
   * Returns a dictionary of sanitized game states for all connected users/sockets.
   * Should be used when emitting game state to all connected users (eg. after a card is played) instead of ```getGameStateForUser``` to minimize DB queries.
   */
  async getGameStatesForConnectedUsers() {
    const connectedUserIds = Array.from(new Set(Object.values(this.connectedSockets).map(socket => {
      return socket.request.session.passport.user.user_id;
    })));
    const gameState = await this.getGameState();
    const sanitizedUserGameStates = {};
    for (const connectedUserId of connectedUserIds) {
      sanitizedUserGameStates[connectedUserId] = await this.sanitizeGameStateForUser(gameState, connectedUserId);
    }
    return sanitizedUserGameStates;
  }

  /**
   * Emits sanitized game state to all connected users/sockets.
   */
  async emitGameStateToConnectedUsers() {
    const gameStatesToEmit = await this.getGameStatesForConnectedUsers();
    for (const socketId in this.connectedSockets) {
      const socket = this.connectedSockets[socketId];
      socket.emit("game_state", gameStatesToEmit[socket.request.session.passport.user.user_id]);
    }
  }

  /**
   * Returns the sanitized game state (cards that the user shouldn't see are hidden) for a user.
   * This should only be used when emitting game state to a single user (only occurs during initial socket connection).
   */
  async getGameStateForUser(userId) {
    return await this.sanitizeGameStateForUser(await this.getGameState(), userId);
  }

  /**
   * Given a game state and user:
   * Returns a game state where cards that the given user should not be able to see (other player's cards, the deck, etc.) are hidden.
   */
  sanitizeGameStateForUser(gameState, userId) {
    // If game has ended, reveal all cards to the user
    if (gameState.ended) {
      return gameState;
    }
    // If game hasn't ended, some cards should be hidden from the user
    const {
      cards,
      ...restOfGameState
    } = gameState;
    const sanitizedGameState = {
      cards: cards.map(card => {
        // The user can only see their own cards, and the discard pile.
        if (card.user_id === userId || card.location === "DISCARD") {
          return card;
        }
        // Otherwise, the card's card_id (color and value can be determined from card_id), color, and value should be hidden to the user.
        const {
          card_id,
          color,
          value,
          ...restOfCard
        } = card;
        return restOfCard;
      }),
      ...restOfGameState
    };
    return sanitizedGameState;
  }

  /**
   * Retrieves and returns the current game state from DB.
   * The returned game state is unsanitized (all card colors and values are visible).
   */
  async getGameState() {
    return await db.tx(async t => {
      // Retrieve game data from DB
      const game = await this.getGame(t);
      const gameUsers = await this.getGameUsers(t);
      const gameCards = await this.getGameCards(t);

      // Construct game state from retrieved data
      const gameState = {
        started: game.started,
        ended: game.ended,
        chosen_wildcard_color: game.chosen_wildcard_color,
        users: gameUsers,
        cards: gameCards,
      };

      return gameState;
    });
  }

  async getGame(transaction) {
    const game = await (transaction ?? db).one("SELECT started, ended, chosen_wildcard_color FROM games WHERE game_id = $1", [
      this.id,
    ]);
    return game;
  }

  async getGameUsers(transaction) {
    const gameUsers = await (transaction ?? db).manyOrNone(`
      SELECT user_id, username, play_order, seat_order, state, is_host
        FROM game_users
        INNER JOIN users USING(user_id)
        WHERE game_id = $1`, [
      this.id,
    ]);
    return gameUsers;
  }

  async getGameCards(transaction) {
    const gameCards = await (transaction ?? db).manyOrNone(`
      SELECT card_id, color, "value", location, "order", user_id
        FROM game_cards
        INNER JOIN cards USING(card_id)
        WHERE game_id = $1`, [
      this.id,
    ]);
    return gameCards;
  }

  async getDeckCards(transaction) {
    const deckCards = await (transaction ?? db).manyOrNone(`
      SELECT card_id, color, "value", location, "order", user_id
        FROM game_cards
        INNER JOIN cards USING(card_id)
        WHERE game_id = $1 AND location = 'DECK'`, [
      this.id,
    ]);
    return deckCards;
  }

  async getUserHandCards(userId, transaction) {
    const handCards = await (transaction ?? db).manyOrNone(`
      SELECT card_id, color, "value", location, "order", user_id
        FROM game_cards
        INNER JOIN cards USING(card_id)
        WHERE game_id = $1 AND user_id = $2 AND location = 'HAND'`, [
      this.id,
      userId,
    ]);
    return handCards;
  }

  async getCurrentTurnPlayer(transaction) {
    const currentTurnPlayer = await (transaction ?? db).one(`
      SELECT user_id, play_order, state, is_host
        FROM game_users
        WHERE game_id = $1 AND play_order = 0`, [
      this.id,
    ]);
    return currentTurnPlayer;
  }

  async getCurrentTurnPlayerCards(transaction) {
    const handCards = await (transaction ?? db).manyOrNone(`
      SELECT card_id, color, "value", location, "order", user_id
        FROM game_cards
        INNER JOIN cards USING(card_id)
        WHERE game_id = $1 AND user_id = (SELECT user_id FROM game_users WHERE game_id = $1 AND play_order = 0) AND location = 'HAND'`, [
      this.id,
    ]);
    return handCards;
  }

  async getTopDiscardCard(transaction) {
    const topDiscardCard = await (transaction ?? db).oneOrNone(`
      SELECT card_id, color, "value", location, "order", user_id
        FROM game_cards
        INNER JOIN cards USING(card_id)
        WHERE game_id = $1 AND location = 'DISCARD'
        ORDER BY "order" DESC LIMIT 1`, [
      this.id,
    ]);
    return topDiscardCard;
  }

  async setChosenWildcardColor(transaction, color) {
    await (transaction ?? db).none(`
      UPDATE games SET chosen_wildcard_color = $2 WHERE game_id = $1`, [
      this.id,
      color,
    ]);
  }

  async getChosenWildcardColor(transaction) {
    return (await (transaction ?? db).one(`
      SELECT chosen_wildcard_color FROM games WHERE game_id = $1`, [
      this.id,
    ])).chosen_wildcard_color;
  }

  async isGameInProgress(transaction) {
    const game = await this.getGame(transaction);
    return game.started && !game.ended;
  }

  async shuffleDeck(transaction) {
    // Check that game is in progress
    if (!(await this.isGameInProgress(transaction))) {
      throw new ApiClientError("Game has not started or is ended.");
    }
    const deckCards = await this.getDeckCards(transaction);
    // Generate an array of consecutive numbers 0 ... deckCards.length
    const newCardOrders = [...Array(deckCards.length).keys()];
    // Durstenfeld shuffle in-place
    for (let i = newCardOrders.length - 1; i > 0; i--) {
      const rand = Math.floor(Math.random() * (i + 1));
      [newCardOrders[i], newCardOrders[rand]] = [newCardOrders[rand], newCardOrders[i]];
    }
    // Update cards in DB
    await (transaction ?? db).none(`
        UPDATE game_cards
          SET "order" = temp."order"
          FROM (VALUES $2:raw) AS temp(card_id, "order")
          WHERE game_id = $1 AND game_cards.card_id = temp.card_id`, [
      this.id,
      require("pg-promise")().helpers.values(newCardOrders.map((newCardOrder, i) => {
        return {
          card_id: deckCards[i].card_id,
          order: newCardOrder,
        };
      }), ["card_id", "order"]),
    ]);
    this.emitGameEvent({ type: "DECK_SHUFFLED" });
  }

  async mergeDiscardIntoDeckIfDeckEmpty(transaction) {
    // Check that game is in progress
    if (!(await this.isGameInProgress(transaction))) {
      throw new ApiClientError("Game has not started or is ended.");
    }
    // If deck is empty
    if (await (transaction ?? db).one(`SELECT COUNT(*) FROM game_cards WHERE game_id = $1 AND location = 'DECK'`, [this.id]) === 0) {
      // Keep top discard card in discard pile
      const topDiscardCard = await this.getTopDiscardCard(transaction);
      await (transaction ?? db).none(`UPDATE game_cards SET "order" = 0 WHERE game_id = $1 AND card_id = $2`, [this.id, topDiscardCard.card_id]);
      // Merge rest of discard into deck
      await (transaction ?? db).none(`UPDATE game_cards SET location = 'DECK' WHERE game_id = $1 AND location = 'DISCARD' AND card_id != $2`, [this.id, topDiscardCard.card_id]);
      // Shuffle deck
      await this.shuffleDeck(transaction);
    }
  }

  async dealCard(userId, transaction) {
    const deal = async t => {
      // Check that game is in progress
      if (!(await this.isGameInProgress(t))) {
        throw new ApiClientError("Game has not started or is ended.");
      }
      // Replenish deck if needed and deal card
      await this.mergeDiscardIntoDeckIfDeckEmpty(t);
      await t.none(`
        UPDATE game_cards
          SET
            location = 'HAND',
            user_id = $2,
            "order" = 1 + COALESCE(
              (SELECT MAX("order") FROM game_cards WHERE game_id = $1 AND user_id = $2 AND location = 'HAND'), -1
            )
          WHERE
            game_id = $1 AND
            location = 'DECK' AND
            "order" = (
              SELECT MAX("order") FROM game_cards WHERE game_id = $1 AND location = 'DECK'
            )`, [
        this.id,
        userId,
      ]);
    };
    if (!transaction) {
      await db.tx(async t => {
        await deal(t);
      });
    } else {
      await deal(transaction);
    }
    this.emitGameEvent({ type: "DEALT_CARD", user_id: userId });
  }
  
  async dealCardToCurrentTurnPlayer(transaction) {
    const currentTurnPlayer = await this.getCurrentTurnPlayer(transaction);
    await this.dealCard(currentTurnPlayer.user_id, transaction);
  }

  async startGame(requestingUserId) {
    await db.tx(async t => {
      // Check that game is not already started
      const game = await this.getGame(t);
      if (game.started) {
        throw new ApiClientError("The game has already started.");
      }
      // Check that requesting user is host
      const gameUsers = await this.getGameUsers(t);
      const host = gameUsers.find(user => user.is_host);
      if (requestingUserId !== host.user_id) {
        throw new ApiClientError("Only the game host may start the game.");
      }
      // Check that there are at least 2 players
      if (gameUsers.length < 2) {
        throw new ApiClientError("At least 2 players are required to start the game.");
      }
      // Start game
      await t.none(`UPDATE games SET started = TRUE WHERE game_id = $1`, [
        this.id,
      ]);
      await this.shuffleDeck(t);
      await Promise.all(gameUsers.flatMap(user => {
        return new Array(7).fill().map(_ => {
          return this.dealCard(user.user_id, t);
        });
      }));
      // Assign random starting order for users
      const randomOrder = Math.floor(Math.random() * gameUsers.length);
      for (let i = 0; i < gameUsers.length; i++) {
        gameUsers[i].play_order = (randomOrder + i) % gameUsers.length;
      }
      await Promise.all(gameUsers.map(gameUser => {
        return t.none(`UPDATE game_users SET play_order = $3, seat_order = $3 WHERE game_id = $1 AND user_id = $2`, [
          this.id,
          gameUser.user_id,
          gameUser.play_order,
        ]);
      }));
      // Reshuffle deck until top card is not draw 4 - by UNO rules, the initial card cannot be a draw 4
      while((await t.one(`
        SELECT "value"
          FROM game_cards
          INNER JOIN cards USING(card_id)
          WHERE
            game_id = $1 AND
            location = 'DECK' AND
            "order" = (
              SELECT MAX("order") FROM game_cards WHERE game_id = $1 AND location = 'DECK'
            )`, [
        this.id,
      ])).value === "DRAW_FOUR") {
        await this.shuffleDeck(t);
      };
      // Deal initial card onto discard from deck
      await t.none(`
        UPDATE game_cards
          SET
            location = 'DISCARD',
            "order" = 1 + COALESCE(
              (SELECT MAX("order") FROM game_cards WHERE game_id = $1 AND location = 'DISCARD'), -1
            )
          WHERE
            game_id = $1 AND
            location = 'DECK' AND
            "order" = (
              SELECT MAX("order") FROM game_cards WHERE game_id = $1 AND location = 'DECK'
            )`, [
        this.id,
      ]);
      // Ensure current turn player can play a card
      await this.ensureCurrentPlayerCanPlayCard(t);
    });
    this.emitGameEvent({ type: "GAME_STARTED" });
    this.emitGameStateToConnectedUsers();
  }

  async addPlayer(userId) {
    await db.tx(async t => {
      // Check that game is not already started
      const game = await this.getGame(t);
      if (game.started) {
        throw new ApiClientError("The game has already started.");
      }
      // Check that the user isn't already in game
      const gameUsers = await this.getGameUsers(t);
      const existingUser = gameUsers.find(user => user.user_id === userId);
      if (existingUser) {
        throw new ApiClientError("You have already joined the game.");
      }
      // Check that player limit will not be exceeded
      if (gameUsers.length + 1 > 4) {
        throw new ApiClientError("The game is full.");
      }
      // Add player to game
      await t.none(`INSERT INTO game_users(game_id, user_id, play_order, state, is_host) VALUES ($1, $2, -1, 'PLAYING', FALSE)`, [
        this.id,
        userId,
      ]);
    });
    this.emitGameEvent({ type: "PLAYER_JOINED", user_id: userId });
    this.emitGameStateToConnectedUsers();
  }

  async removePlayer(userId) {
    let forfeited = false;
    let gameEnded = false;
    await db.tx(async t => {
      // Check that game is not already ended
      const game = await this.getGame(t);
      if (game.ended) {
        throw new ApiClientError("The game has already ended.");
      }
      // Check that the user is in game
      const gameUsers = await this.getGameUsers(t);
      const userToRemove = gameUsers.find(user => user.user_id === userId);
      if (!userToRemove) {
        throw new ApiClientError("You are not in this game.");
      }
      const remainingPlayers = gameUsers.filter(gameUser => gameUser.user_id !== userToRemove.user_id && gameUser.state === "PLAYING");
      // Remove player from game
      if (await this.isGameInProgress()) {
        // If game is in progress, the user forfeits
        forfeited = true;
        await t.none(`UPDATE game_users SET state = 'LOST' WHERE game_id = $1 AND user_id = $2`, [
          this.id,
          userId,
        ]);
        // Recalculate play order
        const updatedGameUsers = gameUsers.map((gameUser, i) => {
          const updatedGameUser = { ...gameUser };
          // Forfeiting player gets play_order of -1
          if (updatedGameUser.user_id === userId) {
            updatedGameUser.play_order = -1;
          } else {
            // For other players, shift play order down where needed
            if (updatedGameUser.play_order >= userToRemove.play_order) {
              updatedGameUser.play_order--;
            }
          }
          return updatedGameUser;
        });
        await Promise.all(updatedGameUsers.map(updatedGameUser => {
          return t.none(`UPDATE game_users SET play_order = $3 WHERE game_id = $1 AND user_id = $2`, [
            this.id,
            updatedGameUser.user_id,
            updatedGameUser.play_order,
          ]);
        }));
        // Migrate host
        if (userToRemove.is_host) {
          await t.none(`UPDATE game_users SET is_host = FALSE WHERE game_id = $1 AND user_id = $2`, [
            this.id,
            userToRemove.user_id,
          ]);
          // Select random player from remaining players
          const newHost = remainingPlayers[Math.floor(Math.random() * remainingPlayers.length)];
          await t.none(`UPDATE game_users SET is_host = TRUE WHERE game_id = $1 AND user_id = $2`, [
            this.id,
            newHost.user_id,
          ]);
        }
        // Discard player's cards
        await t.none(`UPDATE game_cards SET location = 'DISCARD', "order" = -1, user_id = NULL WHERE game_id = $1 AND user_id = $2`, [
          this.id,
          userToRemove.user_id,
        ]);
        // If one player remaining, remaining player wins by default
        if (remainingPlayers.length === 1) {
          await this.endGameWithWinner(t, remainingPlayers[0].user_id);
          gameEnded = true;
        }
      } else {
        // Otherwise game has not started, so the user is simply removed from the game
        await t.none(`DELETE FROM game_users WHERE game_id = $1 AND user_id = $2`, [
          this.id,
          userId,
        ]);
        // Delete game if no players remain
        if ((await this.getGameUsers(t)).length <= 0) {
          await this.deleteGame(t);
        }
      }
    });
    if (forfeited) {
      this.emitGameEvent({ type: "PLAYER_FORFEIT", user_id: userId });
    }
    this.emitGameEvent({ type: "PLAYER_LEFT", user_id: userId });
    if (gameEnded) {
      this.emitGameEvent({ type: "GAME_ENDED" });
    }
    this.emitGameStateToConnectedUsers();
  }

  /**
   * Plays a card, using a chosen color if played card is a wildcard
   */
  async playCard(requestingUserId, cardId, chosenWildcardColor) {
    await db.tx(async t => {
      // Check that game is in progress
      if (!await this.isGameInProgress(t)) {
        throw new ApiClientError("The game must be in progress.");
      }
      // Check that requesting user is current turn player
      const currentTurnPlayer = await this.getCurrentTurnPlayer(t);
      if (requestingUserId !== currentTurnPlayer.user_id) {
        throw new ApiClientError("It isn't your turn.");
      }
      // Check that requesting user has the card in their hand
      const currentTurnPlayerCards = await this.getCurrentTurnPlayerCards(t);
      const cardToPlay = currentTurnPlayerCards.find(card => card.card_id === cardId);
      if (!cardToPlay) {
        throw new ApiClientError("You don't have the chosen card in your hand.");
      }
      // Check that card is playable
      const topDiscardCard = await this.getTopDiscardCard(t);
      const currentChosenWildcardColor = await this.getChosenWildcardColor(t);
      if (!this.isCardPlayable(cardToPlay, topDiscardCard, currentChosenWildcardColor)) {
        // Note: This error message is not 100% correct on purpose to keep it short, there are cases where cards can be played without matching colors/values eg. wildcards.
        throw new ApiClientError("You have to play a card with the same color or value as the top discard card.");
      }
      // Update chosen wildcard color
      if (cardToPlay.color === "BLACK") {
        if (!chosenWildcardColor) {
          throw new ApiClientError("You have to select a color when you play a wildcard.");
        }
        await this.setChosenWildcardColor(t, chosenWildcardColor);
      } else {
        await this.setChosenWildcardColor(t, null);
      }
      // Play card
      await t.none(`
        UPDATE game_cards
          SET
            location = 'DISCARD',
            "order" = 1 + COALESCE(
              (SELECT MAX("order") FROM game_cards WHERE game_id = $1 AND location = 'DISCARD'), -1
            ),
            user_id = NULL
          WHERE
            game_id = $1 AND
            card_id = $2`, [
        this.id,
        cardId,
      ]);
      // Card effects (draw 2, reverse, skip, draw four)
      const gamePlayers = await this.getGameUsers(t);
      const nextPlayer = gamePlayers.find(user => user.play_order === 1);
      let skipNextPlayer = false;
      let reversePlayOrder = false;
      let nextPlayerCardsToDraw = 0;
      switch (cardToPlay.value) {
        case "DRAW_TWO": {
          // The next player draws two cards.
          // If it is a 2 player game, the next player also has their turn skipped.
          nextPlayerCardsToDraw = 2;
          if (gamePlayers.length === 2) {
            skipNextPlayer = true;
          }
          break;
        }
        case "DRAW_FOUR": {
          // The next player draws four cards and their turn is skipped.
          nextPlayerCardsToDraw = 4;
          skipNextPlayer = true;
          break;
        }
        case "SKIP": {
          // The next player's turn is skipped.
          skipNextPlayer = true;
          break;
        }
        case "REVERSE": {
          // Reverse the turn order, unless:
          // If it is a 2 player game, the reverse card acts like a skip instead.
          if (gamePlayers.length === 2) {
            skipNextPlayer = true;
          } else {
            reversePlayOrder = true;
          }
          break;
        }
        default: {
          break;
        }
      }
      if (nextPlayerCardsToDraw) {
        for (let i = 0; i < nextPlayerCardsToDraw; i++) {
          await this.dealCard(nextPlayer.user_id, t);
        }
      }
      // Check win condition
      // If the player only had 1 card before playing the card (meaning the player has 0 cards after playing), the player wins.
      let gameEnded = false;
      if (currentTurnPlayerCards.length <= 1) {
        await this.endGameWithWinner(t, currentTurnPlayer.user_id);
        gameEnded = true;
      } else {
        // Update play order
        await Promise.all(gamePlayers.map(gamePlayer => {
          // Calculate new play order, taking into account whether the turn order has been reversed or whether a player has been skipped.
          let newOrder = ((reversePlayOrder ? gamePlayers.length - gamePlayer.play_order : gamePlayer.play_order) % gamePlayers.length) - (skipNextPlayer ? 2 : 1);
          if (newOrder < 0) {
            newOrder = gamePlayers.length + newOrder;
          }
          return t.none(`UPDATE game_users SET play_order = $3 WHERE game_id = $1 AND user_id = $2`, [
            this.id,
            gamePlayer.user_id,
            newOrder,
          ]);
        }));
        // Ensure current turn player can play a card
        await this.ensureCurrentPlayerCanPlayCard(t);
      }

      // Return results of turn for game event emitting
      return {
        turnUserId: requestingUserId,
        playedCard: cardToPlay,
        gameEnded: gameEnded,
        nextPlayerSkipped: skipNextPlayer,
        nextPlayer: nextPlayer,
        playOrderReversed: reversePlayOrder,
      };
    }).then(turnResults => {
      // Emit game events based on the result of the turn
      this.emitGameEvent({ type: "CARD_PLAYED", user_id: turnResults.turnUserId, card_color: turnResults.playedCard.color, card_value: turnResults.playedCard.value });
      if (turnResults.nextPlayerSkipped) {
        this.emitGameEvent({ type: "SKIPPED_TURN", user_id: turnResults.nextPlayer.user_id });
      }
      if (turnResults.playOrderReversed) {
        this.emitGameEvent({ type: "REVERSED_TURNS" });
      }
      if (turnResults.gameEnded) {
        this.emitGameEvent({ type: "GAME_ENDED" });
      }
      this.emitGameStateToConnectedUsers();
    });
  }

  /**
   * Ensure that the current turn player can play by drawing cards if needed.
   */
  async ensureCurrentPlayerCanPlayCard(transaction) {
    while (!await this.canCurrentTurnPlayerPlayCard(transaction)) {
      await this.dealCardToCurrentTurnPlayer(transaction);
    }
  }

  /**
   * Returns whether the passed array of cards contains a playable card
   */
  async canCurrentTurnPlayerPlayCard(transaction) {
    const currentTurnPlayerCards = await this.getCurrentTurnPlayerCards(transaction);
    const topDiscardCard = await this.getTopDiscardCard(transaction);
    const chosenWildcardColor = await this.getChosenWildcardColor(transaction);

    for (const card of currentTurnPlayerCards) {
      if (this.isCardPlayable(card, topDiscardCard, chosenWildcardColor)) {
        return true;
      }
    }

    return false;
  }

  isCardPlayable(card, topDiscardCard, chosenWildcardColor) {
    // Card is playable if it is a wildcard, or matches the color/value of the top discard card.
    if (card.color === "BLACK" || card.color === topDiscardCard.color || card.value === topDiscardCard.value) {
      return true;
    }

    // If discard card is a wildcard, allow play if it is black (only happens at beginning of game, if the first card is a wildcard).
    if (topDiscardCard.color === "BLACK") {
      // Allow play if ithe wildcard doesn't have a color (only happens at beginning of game, if the first card that was dealt automatically is a wildcard).
      if (!chosenWildcardColor) {
        return true;
      } else if (card.color === chosenWildcardColor) {
        return true;
      }
    }

    return false;
  }

  /**
   * End the game with a winning user by setting user states to "WON" and "LOST", and setting the game as ended.
   */
  async endGameWithWinner(transaction, winningUserId) {
    await transaction.none(`UPDATE game_users SET state = 'WON' WHERE game_id = $1 AND user_id = $2`, [
      this.id,
      winningUserId,
    ]);
    await transaction.none(`UPDATE game_users SET state = 'LOST' WHERE game_id = $1 AND user_id != $2`, [
      this.id,
      winningUserId,
    ]);
    await transaction.none(`UPDATE games SET ended = TRUE WHERE game_id = $1`, [
      this.id,
    ]);
    this.emitGameEvent({ type: "GAME_ENDED" });
  }

  async deleteGame(transaction) {
    const dg = async t => {
      await t.none(`DELETE FROM game_cards WHERE game_id = $1`, [
        this.id,
      ]);
      await t.none(`DELETE FROM game_users WHERE game_id = $1`, [
        this.id,
      ]);
      await t.none(`DELETE FROM games WHERE game_id = $1`, [
        this.id,
      ]);
    };
    if (!transaction) {
      await db.tx(async t => {
        await dg(t);
      });
    } else {
      await dg(transaction);
    }
    this.emitGameEvent({ type: "GAME_DELETED" });
    this.disconnectSockets();
    this.deleted = true;
  }

  /**
   * Emits a chat message event to all connected sockets.
   */
  emitChatMessage(username, message) {
    for (const socketId in this.connectedSockets) {
      this.connectedSockets[socketId].emit("chat_message", { username: username, message: message });
    }
  }

  /**
   * Types:
   * ------------
   * USER_CONNECTED - User connected (not necessarily a player, may be a spectator).
   *    Additional keys: user_id, username
   * 
   * USER_DISCONNECTED - User disconnected (not necessarily a player, may be a spectator).
   *    Additional keys: user_id, username
   * 
   * PLAYER_JOINED - Player joined the game.
   *    Additional keys: user_id
   * 
   * PLAYER_LEFT - Player left the game.
   *    Additional keys: user_id
   * 
   * PLAYER_FORFEIT - Player forfeited the game.
   *    Additional keys: user_id
   * 
   * DECK_SHUFFLED - The deck was shuffled.
   * 
   * DEALT_CARD - A card was dealt to a player.
   *    Additional keys: user_id
   * 
   * CARD_PLAYED - A card was played by a player.
   *    Additional keys: user_id, card_color, card_value
   * 
   * SKIPPED_TURN - A player's turn was skipped.
   *    Additional keys: user_id
   * 
   * REVERSED_TURNS - The turn order was reversed.
   * 
   * GAME_DELETED - All players left before game started.
   * 
   * GAME_STARTED - Game has been started by the host.
   * 
   * GAME_ENDED - Game has ended due to a player winning.
   */
  emitGameEvent(event) {
    for (const socketId in this.connectedSockets) {
      this.connectedSockets[socketId].emit("game_event", event);
    }
  }

  disconnectSockets() {
    for (const socketId in this.connectedSockets) {
      this.connectedSockets[socketId].disconnect();
    }
  }
}

module.exports = Game;