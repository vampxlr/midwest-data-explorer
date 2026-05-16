import axios from 'axios';

const BASE = '/api';

export const api = {
  health: () => axios.get(`${BASE}/health`),
  schema: () => axios.get(`${BASE}/schema`),
  organizations: () => axios.get(`${BASE}/organizations`),
  registrations: (orgId, page = 1, perPage = 100) =>
    axios.get(`${BASE}/registrations`, { params: { orgId, page, perPage } }),
  profiles: (orgId, registrationId, page = 1, perPage = 200) =>
    axios.get(`${BASE}/profiles`, { params: { orgId, registrationId, page, perPage } }),
  surveyResults: (registrationId, page = 1, perPage = 200) =>
    axios.get(`${BASE}/survey-results`, { params: { registrationId, page, perPage } }),
  surveyResultsAll: (registrationId) =>
    axios.get(`${BASE}/survey-results/all`, { params: { registrationId } }),
  analyticsGradYear: (registrationId, orgId) =>
    axios.get(`${BASE}/analytics/graduation-year`, { params: { registrationId, orgId } }),
  registrationAnswers: (registrationId, orgId) =>
    axios.get(`${BASE}/registration-answers`, { params: { registrationId, orgId } }),
  graphql: (query, variables = {}) =>
    axios.post(`${BASE}/graphql`, { query, variables }),
  clearCache: () => axios.post(`${BASE}/cache/clear`),
};
