var fez = require("../../src/main"),
    jshint = require("fez-jshint");

exports.lint = function(rule) {
  rule.task.each("src/*.js", jshint({
    curly: true,
    indent: 2
  }));
};

exports.default = exports.lint;

fez(module);
