var nopt = require("nopt"),
    ansi = require("ansi"),
    cursor = ansi(process.stdout),
    through = require("through"),
    glob = require("glob"),
    path = require("path"),
    minimatch = require("minimatch"),
    Promise = require("bluebird"),
    isPromise = require("is-promise"),
    fs = require("fs"),
    mkdirp = require("mkdirp"),
    assert = require("assert"),
    Writable = require("stream").Writable,
    exec = require("child_process").exec;

/****************
 *     --o--    *
 *    |   ) |   *
 *    |    )|   *
 *    +----)+   *
 *      Fez     *
 ****************/

function fez(module) {
  var options = nopt({
    "verbose": Boolean
  }, {
    "v": "--verbose"
  });

  var rules = [];

  //One to one or many to one relationships. Repeats the operation for each
  //output if there are multiple, passing the complete input array each time.
  function defineRule(inputs, outputs, operation) {
    toArray(outputs).forEach(function(output) {
      rules.push({ inputs: toArray(inputs), outputs: [output], op: operation });
    });
  }

  //One to one relationships where you want to pass in multiple inputs (i.e from
  //a glob, array, or generator). Repeats the operation for each input with the
  //output.
  defineRule.each = function(inputs, outputs, operation) {
    toArray(inputs).forEach(function(input) {
      rules.push({ inputs: [input], outputs: toArray(outputs), op: operation, each: true });
    });
  };

  //Pass complete input and output arrays to operation Useful for many-many
  //operations, which should really be limited to shell commands. Native fez
  //operations should try very hard to be one-one or many-one operations with a
  //single output.
  defineRule.many = function(inputs, outputs, operation) {
    rules.push({ inputs: toArray(inputs), outputs: toArray(outputs), op: operation, many: true });
  };
  
  //A task is a special rule which has no output. It will be run each time the
  //ruleset is run, since there are no output files with which to compare
  //timestamps.
  defineRule.task = function(inputs, operation) {
    rules.push({ inputs: toArray(inputs), op: operation, task: true });
  };

  defineRule.task.each = function(inputs, operation) {
    toArray(inputs).forEach(function(input) {
      rules.push({ inputs: [input], op: operation, task: true, each: true });
    });
  };

  var ruleset = options.argv.remain.length ? options.argv.remain[0] : 'default';
  module.exports[ruleset](defineRule);

  var outs = [],
      nextTask = 0;

  function oglob(pattern) {
    var matches = [];
    outs.forEach(function(out) {
      if(minimatch(out, pattern))
        matches.push(out);
    });
    return matches;
  }

  var tasks = [];
  function Task(rule) {
    this.rule = rule;
    this.inEdges = 0;
    this.inComplete = 0;
    this.inFiles = [];
    tasks.push(this);
  }
  
  //Iterate over each rule. If the rule is not an 'each' rule, create a new Task
  //object for the entire rule. Iterate over each input, find all the files that
  //match the input glob. If the rule is an 'each' rule, output should be a
  //function -- create an output node for each input file, named as a function
  //of the input file (should also make it possible to have an equal-length
  //array of output names). 
  //
  //   a -> f(a) = a'
  //   b -> f(b) = b'
  //   c -> f(c) = c'
  //
  //Otherwise, there will be a single shared output node for every input file in
  //the rule.
  //
  //   a
  //    \
  //   b - abc'
  //    /
  //   c
  //
  //Right now it's impossible that there would be more than one meaningful
  //output, until I put some more thought into 
  rules.forEach(function(rule) {
    var task;

    //Create a new Task instance for every input file in the rule
    if(rule.task && !rule.each) {
      task = new Task(rule);
    }
    
    //List of inputs->outputs associated with this rule.
    rule.files = {};

    rule.inputs.forEach(function(input) {
      var files = glob.sync(input);
      files.forEach(function(file) {
        if(rule.task && rule.each) {
          //This file is an input to a task and since the rule is an 'each'
          //rule, create a new Task. This means a single Task will have a single
          //input.
          task = new Task();
          task.rule = rule;
          rule.files[file] = task;
        } else if(rule.task) {
          //File is an input to a task. Since the rule *isn't* an 'each' rule,
          //use the shared task for the rule. This means a single task will have
          //multiple inputs.
          rule.files[file] = task;
        } else {
          //File is an input that is transformed into an output file.

          //If it's an 'each' rule, generate the output filename as a function
          //of the input, otherwise use a static output filename.
          var out;
          if(rule.each) out = rule.outputs[0](file); 
          else out = rule.outputs[0];

          //Add the output to the outs list for future calls to oglob
          outs.push(out);

          //Add the input->output relation to the rule's file list
          rule.files[file] = out;
        }
      });
    });
  });

  //Repeat the above iteration, this time using generated output files as inputs
  //to the oglob function so that outputs become inputs of other operations,
  //successively creating edge relationships to form a build graph. Keep
  //repeating the iteration until there are no more changes to the edge list.
  do {
    var changed = false;
    rules.forEach(function(rule) {
      rule.inputs.forEach(function(input) {
        //Find all the generated output filenames which match this input glob
        var files = oglob(input);

        //Iterate over them
        files.forEach(function(file) {
          //If the output isn't in the rule's output file list already, keep going
          if(!rule.files[file]) {
            //We're changing the edge list; trigger another iteration of the loop
            changed = true;

            var out;
            if(rule.each) out = rule.outputs[0](file);
            else out = rule.outputs[0];

            outs.push(out);
            rule.files[file] = out;
          }
        });
      });
    });
  } while(changed);

  //Our build graph, turned into node-> form from the edge list we have
  //currently
  var nodes = {};
  rules.forEach(function(rule) {
    for(var input in rule.files) {
      if(!nodes[input]) {
        node = nodes[input] = [];
        node.inComplete = 0;
        node.inEdges = 0;
        node.file = input;
        node.inFiles = [];
      }

      var output = rule.files[input];
      if(output instanceof Task) {
        output.inEdges++;
        output.inFiles.push(input);
      } else {
        var node;
        if(!nodes[output]) {
          node = nodes[output] = [];
          node.inComplete = 0;
          node.inEdges = 0;
          node.file = output;
          node.inFiles = [input];
          node.rule = rule;
        } else {
          nodes[output].inFiles.push(input);
          nodes[output].rule = rule;
        }

        nodes[output].inEdges++;
      }

      nodes[input].push(output);
    }

    delete rule.files;
  });

  var working = [];

  //Calculate the set of nodes with zero inputs, use them to bootstrap the build
  //process
  for(var filename in nodes) {
    var node = nodes[filename];
    if(node.inEdges === 0) working.push(filename);
  }

  var createdCount = 0,
      taskCount = 0;

  digest(working);
  function digest(working) {
    if(!working.length) return done();

    var newWorking = [];
    var ps = [];
    working.forEach(function(file) {
      if(file instanceof Task) {
        var task = file;
        if(task.inComplete == task.inEdges) {
          ps.push(build(task));
        }
      } else {
        var node = nodes[file];
        if(node.inComplete == node.inEdges) {
          if(node.inFiles.length > 0) {
            ps.push(build(node));
          }

          node.forEach(function(out) {
            if(out instanceof Task) {
              out.inComplete++;
            } else {
              nodes[out].inComplete++;
            }

            if(newWorking.indexOf(out) == -1)
              newWorking.push(out); 
          });
        } else {
          newWorking.push(file);
        }
      }
    });

    Promise.settle(ps).then(function(results) {
      var anyRejected = false;
      results.forEach(function(i) {
        if(i.isRejected())
          anyRejected = true;
      });

      if(anyRejected) {
        cursor.red();
        console.log("An operation has failed. Aborting.");
        cursor.reset();
      } else {
        digest(newWorking);
      }
    });
  }

  function done() {
    if(createdCount === 0 && taskCount === 0) {
      cursor.green();
      console.log("Nothing to be done.");
      cursor.reset();
    }
  }

  function build(node) {
    if(node instanceof Task) {
      //(ibw) Just do it ✓
      taskCount++;
      return node.rule.op(buildInputs(), [node.file]);
    } else {
      if(options.verbose) {
        console.log(node.inFiles.join(" "), "->", node.file);
      }

      if(needsUpdate(node.inFiles, [node.file])) {
        createdCount++;
        
        process.stdout.write("Creating ");
        cursor.green();
        process.stdout.write(node.file + "\n"); 
        cursor.reset();

        var out = node.rule.op(buildInputs(), [node.file]);
        if(isPromise(out)) {
          return out.then(function(buffer) {
            if(buffer !== undefined) { //(ibw) assume it's a Buffer (for now)
              var ps = [];
              ps.push(writep(node.file, buffer));

              return Promise.all(ps);
            }
          });
        } else if(out instanceof Writable) {
          return new Promise(function(resolve, reject) {
            out.pipe(fs.createWriteStream(node.file));
            out.on("end", function() {
              resolve();
            });
          });
        }
      }

      function buildInputs() {
        var inputs = [];
        node.inFiles.forEach(function(file) {
          inputs.push(new Input(file));
        });
        return inputs;
      }
    }
  }
}

fez.exec = function(command) {
  return function(inputs, outputs) {
    var ifiles = inputs.map(function(i) { return i.getFilename(); }).join(" "),
        ofiles = outputs.join(" "),
        pcommand = command.
          replace("%i", ifiles).
          replace("%o", ofiles);

    return new Promise(function(resolve, reject) {
      exec(pcommand, function(err) {
        if(err) reject(err);
        else resolve();
      });
    });
  };
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

    return pattern.replace("%f", f);
  };
};

function Input(filename) {
  this._filename = filename;
}

Input.prototype.asBuffer = function() {
  var file = this._filename;
  return new Promise(function(resolve, reject) {
    fs.readFile(file, function(err, data) {
      if(err) reject(err);
      else resolve(data);
    });
  });
};

Input.prototype.asStream = function() {

};

Input.prototype.getFilename = function() {
  return this._filename;
};

function toArray(obj) {
  if(Array.isArray(obj)) return obj;
  return [obj];
}

function writep(file, data) {
  return new Promise(function(resolve, reject) {
    mkdirp(path.dirname(file), function(err) {
      if(err) reject(err);
      fs.writeFile(file, data, function(err) {
        if(err) reject(err);
        else resolve();
      });
    });
  });
}

function needsUpdate(inputs, outputs) {
  var oldestOutput = Number.MAX_VALUE;
  outputs.forEach(function(out) {
    var dir = path.dirname(out);
    if(mkdirp.sync(dir)) {
      oldestOutput = 0;
    } else {
      try {
        var stat = fs.statSync(out),
            time = stat.mtime.getTime();

        if(time < oldestOutput)
          oldestOutput = time;
      } catch (e) {
        oldestOutput = 0;
      }
    }
  });

  var newestInput = 0;
  inputs.forEach(function(input) {
    try {
      var stat = fs.statSync(input),
          time = stat.mtime.getTime();

      if(time > newestInput)
        newestInput = time;
    } catch(e) {
      newestInput = 0;
    }
  });

  return newestInput > oldestOutput;
}

function union(a, b) {
  var a2 = a.filter(function() { return true; });
  b.forEach(function(e) {
    if(a.indexOf(e) == -1)
      a2.push(e);
  });

  return a2;
}

module.exports = fez;
