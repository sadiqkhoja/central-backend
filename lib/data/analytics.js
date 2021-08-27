// Copyright 2021 ODK Central Developers
// See the NOTICE file at the top-level directory of this distribution and at
// https://github.com/opendatakit/central-backend/blob/master/NOTICE.
// This file is part of ODK Central. It is subject to the license terms in
// the LICENSE file found in the top-level directory of this distribution and at
// https://www.apache.org/licenses/LICENSE-2.0. No part of ODK Central,
// including this file, may be copied, modified, propagated, or distributed
// except according to the terms contained in the LICENSE file.

const uuid = require('uuid/v4');

const metaWithUuidXml = () => {
  const thisUuid = uuid();
  return `<meta><instanceID>uuid:${thisUuid}</instanceID></meta>`;
};

const convertObjectToXml = (data) => {
  // Takes form submission data (of analytics metrics)
  // representated as an Object and turns it into the meat
  // of a form XML submission.

  let output = '';
  if (Array.isArray(data)) {
    for (const i of data) {
      output = output.concat(convertObjectToXml(data[i]));
    }
  } else if (typeof data === 'object') {
    for (const k in data) {
      if (Object.prototype.hasOwnProperty.call(data, k)) {
        output = output.concat(`<${k}>`, convertObjectToXml(data[k]), `</${k}>`);
      }
    }
  } else {
    return data;
  }
  return output;
};

const buildSubmission = (formId, formVersion, data, config) => {
  const submissionData = Object.assign(data, { config });
  const innerXml = convertObjectToXml(submissionData);
  const metaXml = metaWithUuidXml();
  const dataPreamble = 'xmlns:jr="http://openrosa.org/javarosa" xmlns:orx="http://openrosa.org/xforms"';
  return `<?xml version="1.0"?><data ${dataPreamble} id="${formId}" version="${formVersion}">${innerXml}${metaXml}</data>`;
};

module.exports = {
  buildSubmission,
  convertObjectToXml,
  metaWithUuidXml
};

