const express = require("express");
const router = express.Router();

/**
 * POST /api/logout
 * 
 * Deletes the user's session and clears the client's session cookie.
 */
router.post("/", (req, res, next) => {
  try {
    req.session.destroy(err => {
      if (err) {
        return next(err);
      }
      res.redirect("/");
    });
  } catch(e) {
    next(e);
  }
});

module.exports = router;