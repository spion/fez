var path = require("path"),
    Promise = require("bluebird"),
    exec = require("child_process").exec;

var fez = module.exports = {};

fez.exec = function(command) {
  function ex(inputs, outputs) {
    var ifiles = toArray(inputs).map(function(i) { return i.getFilename(); }).join(" "),
        ofiles = outputs.join(" "),
        pcommand = command.
          replace("%i", ifiles).
          replace("%o", ofiles);

    return new Promise(function(resolve, reject) {
      exec(pcommand, function(err) {
        if(err) reject(err);
        else resolve(true);
      });
    });
  };

  ex.value = command;
  return ex;
};

fez.mapFile = function(pattern) {
  return function(input) {
    var f = (function() {
      var basename = path.basename(input);
      var hidden = false;
      if(basename.charAt(0) == ".") {
        hidden = true;
        basename = basename.slice(1);
      }

      var split = basename.split(".");
      if(split.length > 1) {
        if(hidden) return "." + split.slice(0, -1).join(".");
        else return split.slice(0, -1).join(".");
      } else {
        if(hidden) return "." + basename;
        else return basename;
      }
    })();

    return pattern.replace("%f", f).replace("%F", path.basename(input));
  };
};

fez.patsubst = function(pattern, replacement, string) {
  if(Array.isArray(string))
    return string.map(fez.patsubst.bind(null, pattern, replacement));

  var regex = new RegExp(pattern.replace(".", "\\.").replace("%", "(.+)")),
      result = regex.exec(string),
      sub = result[1],
      out = replacement.replace("%", sub);

  return out;
};

function toArray(obj) {
  if(Array.isArray(obj)) return obj;
  return [obj];
}

fez.chain = function(operations) {
  return function(inputs, output) {
    return toPromise(operations[0](inputs, output)).then(function(out) {
      operations.shift();
      return itr(out, output);
    });
  };

  function itr(out, output) {
    if(operations.length > 0) {
      var op = operations.shift();
      if(typeof out === "string") out = new Buffer(out);
      return itr(op([new Input(out)], output));
    } else {
      return out;
    }
  }
};

function toPromise(p) {
  if(isPromise(p)) return p;
  return Promise.resolve(p);
}
