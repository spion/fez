var fez = require("../../src/main.js"),
    less = require("fez-less"),
    clean = require("fez-clean-css");

exports.build = function(rule) {
  rule.each("*.less", fez.mapFile("%f.css"), less({ rootpath: "public/" }));
  rule.each("*.css", fez.mapFile("%f.min.css"), clean());
};

exports.default = exports.build;

fez(module);
