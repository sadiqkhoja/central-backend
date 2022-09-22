const { testService } = require('../../setup');
const testData = require('../../../data/xml');

describe('api: /projects/:id/forms (entity-handling)', () => {

  ////////////////////////////////////////////////////////////////////////////////
  // FORM CREATION RELATED TO ENTITIES
  ////////////////////////////////////////////////////////////////////////////////

  describe('parse form def to get entity def', () => {
    it('should return a Problem if the entity xml is invalid (e.g. missing dataset name)', testService((service) => {
      const xml = `
      <h:html xmlns="http://www.w3.org/2002/xforms" xmlns:h="http://www.w3.org/1999/xhtml" xmlns:jr="http://openrosa.org/javarosa" xmlns:entities="http://www.opendatakit.org/xforms">
        <h:head>
          <model>
            <instance>
              <data id="noDatasetName">
                <meta>
                <entities:entity>
                  <entities:create/>
                  <entities:label/>
                </entities:entity>
                </meta>
              </data>
            </instance>
          </model>
        </h:head>
      </h:html>`;
      return service.login('alice', (asAlice) =>
        asAlice.post('/v1/projects/1/forms')
          .send(xml)
          .set('Content-Type', 'text/xml')
          .expect(400)
          .then(({ body }) => { body.code.should.equal(400.23); }));
    }));

    it('should return the created form upon success', testService((service) =>
      service.login('alice', (asAlice) =>
        asAlice.post('/v1/projects/1/forms')
          .send(testData.forms.simpleEntity)
          .set('Content-Type', 'application/xml')
          .expect(200)
          .then(({ body }) => {
            body.should.be.a.Form();
            body.xmlFormId.should.equal('simpleEntity');

            return asAlice.get('/v1/projects/1/forms/simpleEntity/draft')
              .set('X-Extended-Metadata', 'true')
              .expect(200)
              .then(({ body: getBody }) => {
                getBody.should.be.a.Form();
                getBody.entityRelated.should.equal(true);
              });
          }))));

    it('should accept entity form and save dataset with no binds', testService((service) => {
      const xml = `<h:html xmlns="http://www.w3.org/2002/xforms" xmlns:h="http://www.w3.org/1999/xhtml" xmlns:jr="http://openrosa.org/javarosa" xmlns:entities="http://www.opendatakit.org/xforms">
      <h:head>
        <h:title>nobinds</h:title>
        <model>
          <instance>
            <data id="nobinds">
              <name/>
              <age/>
              <meta>
                <entities:entity entities:dataset="something">
                  <entities:create/>
                  <entities:label/>
                </entities:entity>
              </meta>
            </data>
          </instance>
        </model>
      </h:head>
    </h:html>`;
      return service.login('alice', (asAlice) =>
        asAlice.post('/v1/projects/1/forms')
          .send(xml)
          .set('Content-Type', 'text/xml')
          .expect(200)
          .then(({ body }) => {
            body.should.be.a.Form();
            body.xmlFormId.should.equal('nobinds');
          }));
    }));

    it('should update a dataset with new form draft', testService(async (service, { Datasets }) => {
      // Upload a form and then create a new draft version
      await service.login('alice', (asAlice) =>
        asAlice.post('/v1/projects/1/forms?publish=true')
          .send(testData.forms.simpleEntity)
          .set('Content-Type', 'application/xml')
          .expect(200)
          .then(() => asAlice.post('/v1/projects/1/forms/simpleEntity/draft')
            .expect(200)
            .then(() => asAlice.get('/v1/projects/1/forms/simpleEntity/draft')
              .set('X-Extended-Metadata', 'true')
              .expect(200)
              .then(({ body }) => {
                body.entityRelated.should.equal(true);
              }))));

      // Get all datasets by projectId
      const datasetId = await Datasets.getAllByProjectId(1)
        .then(result => result[0].id);

      await Datasets.getById(datasetId)
        .then(result => {
          result.properties.length.should.be.eql(2);
          result.properties[0].fields.length.should.equal(2);
        });
    }));
  });
});

describe('api: /projects/:id/forms/draft/dataset', () => {

  it('should return all properties of dataset', testService(async (service) => {
    // Upload a form and then create a new draft version
    await service.login('alice', (asAlice) =>
      asAlice.post('/v1/projects/1/forms')
        .send(testData.forms.simpleEntity)
        .set('Content-Type', 'application/xml')
        .expect(200)
        .then(() => asAlice.get('/v1/projects/1/forms/simpleEntity/draft/dataset')
          .expect(200)
          .then(({ body }) => {
            body.should.be.eql([
              {
                name: 'people',
                isNew: true,
                properties: [
                  { name: 'age', isNew: true },
                  { name: 'name', isNew: true }
                ]
              }
            ]);
          })));
  }));

  it('should return nothing if dataset and all properties already exist', testService(async (service) => {
    // Upload a form and then create a new draft version
    await service.login('alice', (asAlice) =>
      asAlice.post('/v1/projects/1/forms?publish=true')
        .send(testData.forms.simpleEntity)
        .set('Content-Type', 'application/xml')
        .expect(200)
        .then(() => asAlice.post('/v1/projects/1/forms')
          .send(testData.forms.simpleEntity.replace(/simpleEntity/, 'simpleEntity2'))
          .expect(200)
          .then(() => asAlice.get('/v1/projects/1/forms/simpleEntity2/draft/dataset')
            .expect(200)
            .then(({ body }) => {
              body.should.be.eql([
                {
                  name: 'people',
                  isNew: false,
                  properties: [
                    {
                      name: 'age',
                      isNew: false
                    },
                    {
                      name: 'name',
                      isNew: false
                    }
                  ]
                }
              ]);
            }))));
  }));

  it('should return properties delta only', testService(async (service) => {
    // Upload a form and then create a new draft version
    await service.login('alice', (asAlice) =>
      asAlice.post('/v1/projects/1/forms?publish=true')
        .send(testData.forms.simpleEntity)
        .set('Content-Type', 'application/xml')
        .expect(200)
        .then(() => asAlice.post('/v1/projects/1/forms')
          .send(testData.forms.simpleEntity
            .replace(/simpleEntity/, 'simpleEntity2')
            .replace(/saveto="name"/, 'saveto="firstName"'))
          .expect(200)
          .then(() => asAlice.get('/v1/projects/1/forms/simpleEntity2/draft/dataset')
            .expect(200)
            .then(({ body }) => {
              body.should.be.eql([{
                name: 'people',
                isNew: false,
                properties: [
                  { name: 'age', isNew: false },
                  { name: 'firstName', isNew: true }
                ]
              }]);
            }))));
  }));

  it('should return dataset name only if no property mapping is defined', testService(async (service) => {
    // Upload a form and then create a new draft version
    await service.login('alice', (asAlice) =>
      asAlice.post('/v1/projects/1/forms')
        .send(testData.forms.simpleEntity.replace(/entities:saveto="\w+"/g, ''))
        .set('Content-Type', 'application/xml')
        .expect(200)
        .then(() => asAlice.get('/v1/projects/1/forms/simpleEntity/draft/dataset')
          .expect(200)
          .then(({ body }) => {
            body.should.be.eql([{
              name: 'people',
              isNew: true,
              properties: []
            }]);
          })));
  }));

});
