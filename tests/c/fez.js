var fez = require("../../src/main.js");

exports.build = function(rule) {
  rule.each("*.c", fez.mapFile("%f.o"), fez.exec("gcc -Wall -c %i -o %o"));
  rule("*.o", "hello", fez.exec("gcc %i -o %o"));
};

exports.default = exports.build;

fez(module);
