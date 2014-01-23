var fez = require("../../src/main"),
    jshint = require("fez-jshint");

exports.lint = stage => {
  /* 
   * Define a rule foro each JavaSript file in the src/ directory. We will run
   * JSHINT once for each source file, and we will not create a hidden output
   * file, which means that it will run every time, regardless of whether inputs
   * have changed. Run this script with --harmony.
   */
  stage(rule => {
    rule(fez.glob("src/*.js"), jshint({
      curly: true,
      indent: 2
    }), { always: true});
  });
};

exports.default = exports.lint;

fez(module);
