var fez = require("../../src/main"),
    jshint = require("fez-jshint");

exports.lint = function(rule) {
  rule.each("src/*.js", fez.mapFile(".fez.jshint.%F~"), jshint({
    curly: true,
    indent: 2
  }));
};

exports.default = exports.lint;

fez(module);
