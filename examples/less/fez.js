var fez = require("../../src/main.js"),
    less = require("fez-less"),
    clean = require("fez-clean-css"),
    concat = require("fez-concat");

exports.build = function(rule) {
  rule("dist/*.min.css", "dist.min.css", concat());
  rule.each("css/*.css", fez.mapFile("dist/%f.min.css"), clean());
  rule.each("*.less", fez.mapFile("css/%f.css"), less({ rootpath: "public/" }));
};

exports.default = exports.build;

fez(module);
