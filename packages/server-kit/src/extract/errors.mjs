// Error of an attachment check / conversion. `code` is one of ATTACHMENT_ERRORS (stable, lower snake case); `details` is
// machine-readable ({ index, name, reason }) and never carries file contents.
export const ATTACHMENT_ERRORS = Object.freeze([
  'too_many_files', 'file_too_large', 'total_too_large', 'unsupported_type', 'type_mismatch', 'no_text',
  'attachments_not_allowed', 'images_not_supported', 'invalid_attachment',
])

export class AttachmentError extends Error {
  constructor(code, details) {
    super(code)
    this.name = 'AttachmentError'
    this.code = code
    if (details !== undefined) this.details = details
  }
}
