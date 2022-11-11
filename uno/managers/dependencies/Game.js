const pgp = require("pg-promise");
const db = require("../../db");

class Game {
  constructor(id) {
    this.id = id;
    this.connectedSockets = {};
  }

  async connect(socket) {
    this.connectedSockets[socket.id] = socket;
    socket.on("disconnect", (reason) => {
      delete this.connectedSockets[socket.id];
      console.log(`[Game ${this.id}] Removed socket ID ${socket.id} (${reason}). # of connected sockets: ${Object.keys(this.connectedSockets).length}`);
    });
    console.log(`[Game ${this.id}] Added socket ID ${socket.id}, established by user ${socket.request.session.passport.user.username}. # of connected sockets: ${Object.keys(this.connectedSockets).length}`);

    socket.emit("game_state", await this.getGameStateForUser(socket.request.session.passport.user.user_id));

    this.emitGameEvent({ type: "PLAYER_JOINED", username: socket.request.session.passport.user.username });
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
   * Returns the sanitized game state (cards that the user shouldn't see are hideen) for a user.
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
    const {
      cards,
      ...restOfGameState
    } = gameState;
    const largestOrderInDiscardPile = cards
      .filter(card => card.location === "DISCARD")
      .reduce((largestOrder, currentCard) => {
        if (!largestOrder || currentCard.order > largestOrder) {
          return currentCard.order;
        } else {
          return largestOrder;
        }
      }, null);
    const sanitizedGameState = {
      cards: cards.map(card => {
        // The user can only see their own cards, and the top card of the discard pile.
        if (card.user_id === userId) {
          return card;
        }
        if (card.location === "DISCARD" && card.order === largestOrderInDiscardPile) {
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
    // Retrieve game data from DB
    const game = await db.one(new pgp.PreparedStatement({
      name: "get-game",
      text: "SELECT started, ended FROM games WHERE game_id = $1",
    }), [
      this.id,
    ]);

    const gameUsers = await this.getGameUsers();

    const gameCards = await this.getGameCards();

    // Construct game state from retrieved data
    const gameState = {
      started: game.started,
      ended: game.ended,
      users: gameUsers,
      cards: gameCards,
    };

    return gameState;
  }

  async getGameUsers(transaction) {
    const gameUsers = await (transaction ?? db).manyOrNone(new pgp.PreparedStatement({
      name: "get-game-users",
      text: `
        SELECT user_id, username, play_order, state, is_host
          FROM game_users
          INNER JOIN users USING(user_id)
          WHERE game_id = $1`,
    }), [
      this.id,
    ]);
    return gameUsers;
  }

  async getGameCards(transaction) {
    const gameCards = await (transaction ?? db).manyOrNone(new pgp.PreparedStatement({
      name: "get-game-cards",
      text: `
        SELECT card_id, color, \"value\", location, \"order\", user_id
          FROM game_cards
          INNER JOIN cards USING(card_id)
          WHERE game_id = $1`,
    }), [
      this.id,
    ]);
    return gameCards;
  }

  async getDeckCards(transaction) {
    const deckCards = await (transaction ?? db).manyOrNone(new pgp.PreparedStatement({
      name: "get-deck-cards",
      text: `
        SELECT card_id, color, \"value\", location, \"order\", user_id
          FROM game_cards
          INNER JOIN cards USING(card_id)
          WHERE game_id = $1 AND location = 'DECK'`,
    }), [
      this.id,
    ]);
    return deckCards;
  }

  async getUserHandCards(userId, transaction) {
    const deckCards = await (transaction ?? db).manyOrNone(new pgp.PreparedStatement({
      name: "get-user-hand-cards",
      text: `
        SELECT card_id, color, \"value\", location, \"order\", user_id
          FROM game_cards
          INNER JOIN cards USING(card_id)
          WHERE game_id = $1 AND user_id = $2 AND location = 'HAND'`,
    }), [
      this.id,
      userId,
    ]);
    return deckCards;
  }

  async shuffleDeck(transaction) {
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
    // If deck is empty
    if (await (transaction ?? db).one(new pgp.PreparedStatement({
      name: "get-deck-card-count",
      text: `SELECT COUNT(*) FROM game_cards WHERE game_id = $1 AND location = 'DECK'`,
    }), [this.id]) === 0) {
      // Merge discard into deck
      await (transaction ?? db).none(new pgp.PreparedStatement({
        name: "merge-discard-into-deck",
        text: `UPDATE game_cards SET location = 'DECK' WHERE game_id = $1 AND location = 'DISCARD'`,
      }), [this.id]);
      // Shuffle deck
      await this.shuffleDeck(transaction);
    }
  }

  async dealCard(userId) {
    await db.tx(async t => {
      await this.mergeDiscardIntoDeckIfDeckEmpty(t);

      await t.none(new pgp.PreparedStatement({
        name: "deal-card",
        text: `
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
              )`,
      }), [
        this.id,
        userId,
      ]);
    });
  }

  /**
   * Emits sanitized game states (cards that the user shouldn't see are hidden) to all connected sockets.
   */
  async emitGameStates() {
    const sanitizedUserGameStates = await this.getGameStatesForConnectedUsers();
    for (const socketId in this.connectedSockets) {
      this.connectedSockets[socketId].emit("game_state", sanitizedUserGameStates[this.connectedSockets[socketId].request.session.passport.user.user_id]);
    }
  }

  emitChatMessage(username, message) {
    for (const socketId in this.connectedSockets) {
      this.connectedSockets[socketId].emit("chat_message", { username: username, message: message });
    }
  }

  emitGameEvent(event) {
    for (const socketId in this.connectedSockets) {
      this.connectedSockets[socketId].emit("game_event", event);
    }
  }
}

module.exports = Game;