var fez = require("../../src/main.js"),
    less = require("fez-less"),
    clean = require("fez-clean-css");

exports.build = function(rule) {
  rule("dist/*.min.css", "dist.min.css", clean());
  rule.each("*.less", fez.mapFile("dist/%f.min.css"), less({ rootpath: "public/" }), clean());
};

exports.default = exports.build;

fez(module);
