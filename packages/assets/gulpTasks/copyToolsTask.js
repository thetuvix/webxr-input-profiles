const gulp = require('gulp');
const through = require('through2');

const taskPaths = require('./taskPaths');

function convertMergeScript() {
  return through.obj((vinylFile, encoding, callback) => {
    const newFile = vinylFile.clone();
    if (vinylFile.relative === 'mergeProfile.js') {
      let fileContents = vinylFile.contents.toString();
      fileContents = fileContents.replace('module.exports =', 'export default');
      newFile.contents = Buffer.from(fileContents);
    }
    callback(null, newFile);
  });
}

function copyProfilesTools() {
  return gulp.src(taskPaths.toolsGlob)
    .pipe(convertMergeScript())
    .pipe(gulp.dest(taskPaths.toolsDest));
}

module.exports = copyProfilesTools;
