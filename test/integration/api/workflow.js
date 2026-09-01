const appRoot = require('app-root-path');
const { sql } = require('slonik');
const { testService } = require('../setup');
const should = require('should');
const { v4: uuid } = require('uuid');
const { exhaust } = require(appRoot + '/lib/worker/worker');

describe.only('api: complete workflow', () => {
  it('switch the project', testService(async (service, container) => {
    const asAlice = await service.login('alice');

    // 1. Create a new project
    const { body: project } = await asAlice.post('/v1/projects')
      .send({ name: 'Survey Project' })
      .expect(200);
    project.should.be.a.Project();
    project.name.should.equal('Survey Project');

    const projectId = project.id;

    // 2. Create a dataset via API
    await asAlice.post(`/v1/projects/${projectId}/datasets`)
      .send({ name: 'trees' })
      .expect(200)
      .then(({ body }) => {
        body.should.be.a.Dataset();
        body.name.should.equal('trees');
      });

    // Add a property to the trees dataset
    await asAlice.post(`/v1/projects/${projectId}/datasets/trees/properties`)
      .send({ name: 'species' })
      .expect(200);

    // Add an entity to the trees dataset so it can be consumed
    await asAlice.post(`/v1/projects/${projectId}/datasets/trees/entities`)
      .send({ uuid: uuid(), label: 'Oak Tree', data: { species: 'oak' } })
      .expect(200);

    // 3. Create a form that:
    //    - Creates a new dataset called "registrations"
    //    - Consumes the existing "trees" dataset
    //    - Has a binary attachment field
    const formXml = `<?xml version="1.0"?>
<h:html xmlns="http://www.w3.org/2002/xforms" xmlns:h="http://www.w3.org/1999/xhtml" xmlns:jr="http://openrosa.org/javarosa" xmlns:orx="http://openrosa.org/xforms" xmlns:entities="http://www.opendatakit.org/xforms/entities" xmlns:odk="http://www.opendatakit.org/xforms">
<h:head>
  <h:title>Tree Registration</h:title>
  <model entities:entities-version="2024.1.0" odk:xforms-version="1.0.0">
    <instance>
      <data id="treeRegistration" orx:version="1.0">
        <tree_ref/>
        <registrant_name/>
        <photo/>
        <meta>
          <instanceID/>
          <entity dataset="registrations" id="" create="">
            <label/>
          </entity>
        </meta>
      </data>
    </instance>
    <instance id="trees" src="jr://file-csv/trees.csv"/>
    <bind nodeset="/data/tree_ref" type="string"/>
    <bind nodeset="/data/registrant_name" type="string" entities:saveto="registrant"/>
    <bind nodeset="/data/photo" type="binary"/>
    <bind nodeset="/data/meta/instanceID" type="string" readonly="true()" jr:preload="uid"/>
  </model>
</h:head>
<h:body>
  <select1 ref="/data/tree_ref">
    <label>Select tree</label>
    <itemset nodeset="instance('trees')/root/item">
      <value ref="name"/>
      <label ref="label"/>
    </itemset>
  </select1>
  <input ref="/data/registrant_name">
    <label>Registrant name</label>
  </input>
  <upload ref="/data/photo" mediatype="image/*">
    <label>Take a photo</label>
  </upload>
</h:body>
</h:html>`;

    await asAlice.post(`/v1/projects/${projectId}/forms?publish=true`)
      .set('Content-Type', 'application/xml')
      .send(formXml)
      .expect(200)
      .then(({ body }) => {
        body.should.be.a.Form();
        body.xmlFormId.should.equal('treeRegistration');
      });

    // Verify the new dataset "registrations" was created by the form
    await asAlice.get(`/v1/projects/${projectId}/datasets/registrations`)
      .expect(200)
      .then(({ body }) => {
        body.should.be.a.Dataset();
        body.name.should.equal('registrations');
      });

    // 4. Create a public access link
    const { body: publicLink } = await asAlice.post(`/v1/projects/${projectId}/forms/treeRegistration/public-links`)
      .send({ displayName: 'Field Survey Link' })
      .expect(200);
    publicLink.should.be.a.PublicLink();
    publicLink.displayName.should.equal('Field Survey Link');
    should.exist(publicLink.token);

    // Get form's enketoId and construct the public access URL
    const { body: form } = await asAlice.get(`/v1/projects/${projectId}/forms/treeRegistration`)
      .expect(200);
    const publicAccessUrl = `http://central-dev.localhost:8989/f/${form.enketoId}?st=${publicLink.token}`;
    console.log('\n=== PUBLIC ACCESS LINK ===');
    console.log(publicAccessUrl);
    console.log('===========================\n');

    // 5. Create an app-user
    const { body: appUser } = await asAlice.post(`/v1/projects/${projectId}/app-users`)
      .send({ displayName: 'Field Worker' })
      .expect(200);
    appUser.should.be.a.FieldKey();
    appUser.displayName.should.equal('Field Worker');
    should.exist(appUser.token);

    // Assign app-user to the form
    await asAlice.post(`/v1/projects/${projectId}/forms/treeRegistration/assignments/app-user/${appUser.id}`)
      .expect(200);

    // 6. Make 5 submissions with 1 attachment each
    // First 3 submissions using app-user token
    for (let i = 1; i <= 3; i++) {
      const instanceId = `submission-${uuid()}`;
      const submissionXml = `<?xml version="1.0"?>
<data xmlns:jr="http://openrosa.org/javarosa" xmlns:entities="http://www.opendatakit.org/xforms/entities" id="treeRegistration" version="1.0">
<tree_ref>tree1</tree_ref>
<registrant_name>Person ${i}</registrant_name>
<photo>photo${i}.jpg</photo>
<meta>
  <instanceID>${instanceId}</instanceID>
  <entity dataset="registrations" id="uuid:${uuid()}" create="1">
    <label>Registration ${i}</label>
  </entity>
</meta>
</data>`;

      await service.post(`/v1/key/${appUser.token}/projects/${projectId}/submission`)
        .set('X-OpenRosa-Version', '1.0')
        .attach('xml_submission_file', Buffer.from(submissionXml), { filename: 'data.xml' })
        .attach(`photo${i}.jpg`, Buffer.from(`fake image content ${i}`), { filename: `photo${i}.jpg` })
        .expect(201);
    }

    // Next 2 submissions using public link token (non-OpenRosa endpoint)
    for (let i = 4; i <= 5; i++) {
      const instanceId = `sub${i}`;
      const submissionXml = `<?xml version="1.0"?>
<data xmlns:jr="http://openrosa.org/javarosa" xmlns:entities="http://www.opendatakit.org/xforms/entities" id="treeRegistration" version="1.0">
<tree_ref>tree1</tree_ref>
<registrant_name>Person ${i}</registrant_name>
<photo>photo${i}.jpg</photo>
<meta>
  <instanceID>${instanceId}</instanceID>
  <entity dataset="registrations" id="uuid:${uuid()}" create="1">
    <label>Registration ${i}</label>
  </entity>
</meta>
</data>`;

      // Submit XML first
      await service.post(`/v1/key/${publicLink.token}/projects/${projectId}/forms/treeRegistration/submissions`)
        .send(submissionXml)
        .set('Content-Type', 'text/xml')
        .expect(200);

      // Then upload attachment separately
      await service.post(`/v1/key/${publicLink.token}/projects/${projectId}/forms/treeRegistration/submissions/${instanceId}/attachments/photo${i}.jpg`)
        .send(Buffer.from(`fake image content ${i}`))
        .set('Content-Type', 'application/octet-stream')
        .expect(200);
    }

    // Verify submissions were created
    const { body: submissions } = await asAlice.get(`/v1/projects/${projectId}/forms/treeRegistration/submissions`)
      .expect(200);
    submissions.length.should.equal(5);

    // Verify attachments exist for the first submission
    const { body: attachments } = await asAlice.get(`/v1/projects/${projectId}/forms/treeRegistration/submissions/${submissions[0].instanceId}/attachments`)
      .expect(200);
    attachments.length.should.equal(1);
    attachments[0].exists.should.equal(true);

    // Process entity creation via worker
    await exhaust(container);

    // Verify entities were created in the registrations dataset
    const { body: entities } = await asAlice.get(`/v1/projects/${projectId}/datasets/registrations/entities`)
      .expect(200);
    entities.length.should.equal(5);

    // 7. Create a new project to migrate resources to
    const { body: newProject } = await asAlice.post('/v1/projects')
      .send({ name: 'New Survey Project' })
      .expect(200);
    newProject.should.be.a.Project();
    const newProjectId = newProject.id;

    // Get the new project's actee ID
    const { acteeId: newProjectActeeId } = await container.one(sql`
      SELECT "acteeId" FROM projects WHERE id = ${newProjectId}
    `);

    // Get the form's actee ID
    const { acteeId: formActeeId } = await container.one(sql`
      SELECT "acteeId" FROM forms WHERE "xmlFormId" = 'treeRegistration' AND "projectId" = ${projectId}
    `);

    // Get both datasets' actee IDs (trees and registrations)
    const { acteeId: treesActeeId } = await container.one(sql`
      SELECT "acteeId" FROM datasets WHERE name = 'trees' AND "projectId" = ${projectId}
    `);
    const { acteeId: registrationsActeeId } = await container.one(sql`
      SELECT "acteeId" FROM datasets WHERE name = 'registrations' AND "projectId" = ${projectId}
    `);

    // Get the field_key's actor actee ID
    const { acteeId: fieldKeyActeeId } = await container.one(sql`
      SELECT actors."acteeId" FROM field_keys
      JOIN actors ON field_keys."actorId" = actors.id
      WHERE field_keys."projectId" = ${projectId}
      LIMIT 1
    `);

    // 8. Update the projectId of the resources to the new project using direct SQL
    await container.run(sql`
      UPDATE forms SET "projectId" = ${newProjectId} WHERE "projectId" = ${projectId}
    `);
    await container.run(sql`
      UPDATE datasets SET "projectId" = ${newProjectId} WHERE "projectId" = ${projectId}
    `);
    await container.run(sql`
      UPDATE field_keys SET "projectId" = ${newProjectId} WHERE "projectId" = ${projectId}
    `);

    // 9. Update the parent actee ID of the datasets, form, and app user
    await container.run(sql`
      UPDATE actees SET parent = ${newProjectActeeId} WHERE id = ${formActeeId}
    `);
    await container.run(sql`
      UPDATE actees SET parent = ${newProjectActeeId} WHERE id = ${treesActeeId}
    `);
    await container.run(sql`
      UPDATE actees SET parent = ${newProjectActeeId} WHERE id = ${registrationsActeeId}
    `);
    await container.run(sql`
      UPDATE actees SET parent = ${newProjectActeeId} WHERE id = ${fieldKeyActeeId}
    `);

    // Verify /form-links/:enketoId/form returns the right form using public link token
    // This confirms the form is accessible via the publicAccessUrl after migration
    await service.get(`/v1/form-links/${form.enketoId}/form?st=${publicLink.token}`)
      .expect(200)
      .then(({ body }) => {
        body.xmlFormId.should.equal('treeRegistration');
        body.projectId.should.equal(newProjectId);
      });

    // 10. Create 2 new submissions using the new project URL
    const newSubmissionInstanceIds = [];

    // First submission using app-user token
    {
      const instanceId = `submission-${uuid()}`;
      newSubmissionInstanceIds.push(instanceId);
      const submissionXml = `<?xml version="1.0"?>
<data xmlns:jr="http://openrosa.org/javarosa" xmlns:entities="http://www.opendatakit.org/xforms/entities" id="treeRegistration" version="1.0">
<tree_ref>tree1</tree_ref>
<registrant_name>Person 6</registrant_name>
<photo>photo6.jpg</photo>
<meta>
  <instanceID>${instanceId}</instanceID>
  <entity dataset="registrations" id="uuid:${uuid()}" create="1">
    <label>Registration 6</label>
  </entity>
</meta>
</data>`;

      await service.post(`/v1/key/${appUser.token}/projects/${newProjectId}/submission`)
        .set('X-OpenRosa-Version', '1.0')
        .attach('xml_submission_file', Buffer.from(submissionXml), { filename: 'data.xml' })
        .attach('photo6.jpg', Buffer.from('fake image content 6'), { filename: 'photo6.jpg' })
        .expect(201);
    }

    // Second submission using public link token (non-OpenRosa endpoint)
    {
      const instanceId = 'sub7';
      newSubmissionInstanceIds.push(instanceId);
      const submissionXml = `<?xml version="1.0"?>
<data xmlns:jr="http://openrosa.org/javarosa" xmlns:entities="http://www.opendatakit.org/xforms/entities" id="treeRegistration" version="1.0">
<tree_ref>tree1</tree_ref>
<registrant_name>Person 7</registrant_name>
<photo>photo7.jpg</photo>
<meta>
  <instanceID>${instanceId}</instanceID>
  <entity dataset="registrations" id="uuid:${uuid()}" create="1">
    <label>Registration 7</label>
  </entity>
</meta>
</data>`;

      // Submit XML first
      await service.post(`/v1/key/${publicLink.token}/projects/${newProjectId}/forms/treeRegistration/submissions`)
        .send(submissionXml)
        .set('Content-Type', 'text/xml')
        .expect(200);

      // Then upload attachment separately
      await service.post(`/v1/key/${publicLink.token}/projects/${newProjectId}/forms/treeRegistration/submissions/${instanceId}/attachments/photo7.jpg`)
        .send(Buffer.from('fake image content 7'))
        .set('Content-Type', 'application/octet-stream')
        .expect(200);
    }

    // Verify submissions exist on the new project
    const { body: newSubmissions } = await asAlice.get(`/v1/projects/${newProjectId}/forms/treeRegistration/submissions`)
      .expect(200);
    newSubmissions.length.should.equal(7); // 5 original + 2 new

    // 11. Test OData endpoint using new project URL
    const { body: odataResponse } = await asAlice.get(`/v1/projects/${newProjectId}/forms/treeRegistration.svc/Submissions`)
      .expect(200);
    odataResponse.value.length.should.equal(7);

    // 12. Test attachment retrieval using new project URL
    const { body: newAttachments } = await asAlice.get(`/v1/projects/${newProjectId}/forms/treeRegistration/submissions/${newSubmissionInstanceIds[0]}/attachments`)
      .expect(200);
    newAttachments.length.should.equal(1);
    newAttachments[0].exists.should.equal(true);
    newAttachments[0].name.should.equal('photo6.jpg');

    // Download the actual attachment content
    await asAlice.get(`/v1/projects/${newProjectId}/forms/treeRegistration/submissions/${newSubmissionInstanceIds[0]}/attachments/photo6.jpg`)
      .expect(200)
      .then(({ body }) => {
        body.toString('utf8').should.equal('fake image content 6');
      });

    // Process entity creation for new submissions via worker
    await exhaust(container);

    // Verify all 7 entities exist in the new project's registrations dataset
    const { body: allEntities } = await asAlice.get(`/v1/projects/${newProjectId}/datasets/registrations/entities`)
      .expect(200);
    allEntities.length.should.equal(7); // 5 original + 2 new

    // 13. Print all audit logs
    const { body: audits } = await asAlice.get('/v1/audits')
      .set('X-Extended-Metadata', 'true')
      .expect(200);
    console.log(audits);
    console.log('\n=== AUDIT LOGS ===');
    audits.forEach((audit) => {
      console.log(`[${audit.loggedAt}] ${audit.action} | actor: ${audit.actor?.displayName || 'N/A'} | details: ${JSON.stringify(audit.details)}`);
    });
  }));
});
