const createError = require("http-errors");
const express = require("express");
const path = require("path");
const cookieParser = require("cookie-parser");
const logger = require("morgan");

if (process.env.NODE_ENV === "development") {
  require("dotenv").config();
}

const app = express();

// view engine setup
app.set("views", path.join(__dirname, "views"));
app.set("view engine", "pug");

app.use(logger("dev"));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, "public")));

// use session authentication
app.use(require("./middleware/session"));

// routes
app.use("/", require("./routes/index"));
app.use("/api/users", require("./routes/users"), require("./middleware/ApiErrorHandler"));
app.use("/api/games", require("./routes/games"), require("./middleware/ApiErrorHandler"));
app.use("/api/login", require("./routes/login"), require("./middleware/ApiErrorHandler"));
app.use("/api/logout", require("./routes/logout"), require("./middleware/ApiErrorHandler"));
app.use("/api/global-chat", require("./routes/global-chat"), require("./middleware/ApiErrorHandler"));

// catch 404 and forward to error handler
app.use(function (req, res, next) {
  next(createError(404));
});

// error handler
app.use(function (err, req, res, next) {
  // set locals, only providing error in development
  res.locals.message = err.message;
  res.locals.error = req.app.get("env") === "development" ? err : {};

  // render the error page
  res.status(err.status || 500);
  res.render("error");
});

module.exports = app;