var fez = require("../../src/main.js");

exports.build = function(stage) {
  /*
   * Note that these don't need to be in different stages. This is just for testing purposes.
   */
  stage(function(rule) {
    rule.each("*.c", fez.mapFile("%f.o"), fez.exec("gcc -Wall -c %i -o %o"));
  });

  stage(function(rule) {
    rule("*.o", "hello", fez.exec("gcc %i -o %o"));
  });
};

exports.default = exports.build;

fez(module);
