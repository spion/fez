var Promise = require("bluebird"),
    fs = require("fs");

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
  return fs.createReadStream(this._filename);
};

Input.prototype.getFilename = function() {
  return this._filename;
};

module.exports = Input;
