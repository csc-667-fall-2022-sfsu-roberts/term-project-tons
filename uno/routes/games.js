const express = require("express");
const router = express.Router();
const Joi = require("joi");
const passport = require("../middleware/passport");
const GameManager = require("../managers/GameManager");
const ApiNotFoundError = require("../errors/ApiNotFoundError");
const ApiUnauthorizedError = require("../errors/ApiUnauthorizedError");

/**
 * GET /api/games
 * 
 * Gets games for lobby.
 */
router.get("/", passport.session(), async (req, res, next) => {
  try {
    if (!req.user) {
      throw new ApiUnauthorizedError("Not logged in.");
    }
    const games = await GameManager.getAllGames();

    return res.status(200).json({
      games: games,
    });
  } catch(e) {
    next(e);
  }
});

/**
 * POST /api/games
 * 
 * Creates a new game.
 */
router.post("/", passport.session(), async (req, res, next) => {
  try {
    if (!req.user) {
      throw new ApiUnauthorizedError("Not logged in.");
    }

    // Create game
    const hostUserId = req.user.user_id;
    const newGameId = await GameManager.createNewGame(hostUserId);

    return res.status(200).json({
      game_id: newGameId,
    });
  } catch(e) {
    next(e);
  }
});

/**
 * POST /api/games/:gameId/start
 * 
 * Starts a game. Requesting user must have created the game (must be the host).
 */
router.post("/:gameId/start", passport.session(), async (req, res, next) => {
  try {
    if (!req.user) {
      throw new ApiUnauthorizedError("Not logged in.");
    }

    // Retrieve game instance
    const game = await GameManager.getGameByGameId(req.params.gameId);
    if (!game) {
      throw new ApiNotFoundError(`Game with ID '${req.params.gameId}' does not exist.`);
    }

    // Start game, throws error if requesting user is not host or game is already started
    await game.startGame(req.user.user_id);

    return res.status(200).send();
  } catch(e) {
    next(e);
  }
});

/**
 * POST /api/games/:gameId/join
 * 
 * Joins a game. Game must not be in progress.
 */
 router.post("/:gameId/join", passport.session(), async (req, res, next) => {
  try {
    if (!req.user) {
      throw new ApiUnauthorizedError("Not logged in.");
    }

    // Retrieve game instance
    const game = await GameManager.getGameByGameId(req.params.gameId);
    if (!game) {
      throw new ApiNotFoundError(`Game with ID '${req.params.gameId}' does not exist.`);
    }

    // Join game
    await game.addPlayer(req.user.user_id);

    return res.status(200).send();
  } catch(e) {
    next(e);
  }
});

/**
 * POST /api/games/:gameId/leave
 * 
 * Leaves a game. If game is in progress, user forfeits.
 */
 router.post("/:gameId/leave", passport.session(), async (req, res, next) => {
  try {
    if (!req.user) {
      throw new ApiUnauthorizedError("Not logged in.");
    }

    // Retrieve game instance
    const game = await GameManager.getGameByGameId(req.params.gameId);
    if (!game) {
      throw new ApiNotFoundError(`Game with ID '${req.params.gameId}' does not exist.`);
    }

    // Leave game
    await game.removePlayer(req.user.user_id);

    return res.status(200).send();
  } catch(e) {
    next(e);
  }
});

/**
 * POST /api/games/:gameId/chat
 * 
 * Sends a chat message to a game.
 */
router.post("/:gameId/chat", passport.session(), async (req, res, next) => {
  try {
    if (!req.user) {
      throw new ApiUnauthorizedError("Not logged in.");
    }

    // Verify request body has all required properties and has correct format
    const schema = Joi.object({
      message: Joi.string().max(512).required(),
    });
    const validated = await schema.validateAsync(req.body);

    // Retrieve game instance
    const game = await GameManager.getGameByGameId(req.params.gameId);
    if (!game) {
      throw new ApiNotFoundError(`Game with ID '${req.params.gameId}' does not exist.`);
    }

    // Send chat message
    await game.emitChatMessage(req.user.username, validated.message);

    return res.status(200).send();
  } catch(e) {
    next(e);
  }
});

/**
 * POST /api/games/:gameId/play-card
 * 
 * Plays a card.
 */
router.post("/:gameId/play-card", passport.session(), async (req, res, next) => {
  try {
    if (!req.user) {
      throw new ApiUnauthorizedError("Not logged in.");
    }

    // Verify request body has all required properties and has correct format
    const schema = Joi.object({
      card_id: Joi.number().integer().required(),
      chosen_wildcard_color: Joi.valid("RED", "YELLOW", "BLUE", "GREEN"),
    });
    const validated = await schema.validateAsync(req.body);

    // Retrieve game instance
    const game = await GameManager.getGameByGameId(req.params.gameId);
    if (!game) {
      throw new ApiNotFoundError(`Game with ID '${req.params.gameId}' does not exist.`);
    }

    // Play card
    await game.playCard(req.user.user_id, validated.card_id, validated.chosen_wildcard_color);

    return res.status(200).send();
  } catch(e) {
    next(e);
  }
});

module.exports = router;