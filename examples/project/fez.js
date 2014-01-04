var fez = require("fez"),
    less = require("monk-less"),
    clean = require("monk-clean-css");

exports.build = function(rule) {
  rule.each(fez.glob("*.less"), fez.mapFile("%f.min.css"), less({ rootpath: "public/" }), clean);
};

exports.test = function(rule) {

};

exports.default = exports.build;

fez(module);
