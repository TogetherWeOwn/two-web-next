// Admin event-form barrel (structural split; zero behavior change). One module per
// concern lives beside this file: the page composition in ./event-form-page, the
// validation notice and fields in ./event-form-fields, the status actions in
// ./event-form-status and the RSVP roster with pagination in ./event-form-roster.
// This file re-exports the historic public name so existing importers keep
// working untouched.

export { EventFormPage } from "./event-form-page";
