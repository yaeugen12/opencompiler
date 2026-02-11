const { body, param, query, validationResult } = require('express-validator');

/**
 * Middleware to handle validation errors
 */
const handleValidationErrors = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      error: 'Validation failed',
      details: errors.array(),
    });
  }
  next();
};

/**
 * Validators for different endpoints
 */

const validateBuildId = [
  param('buildId')
    .isUUID()
    .withMessage('Invalid build ID format'),
  handleValidationErrors,
];

const validateGithubRepo = [
  body('repoUrl')
    .isURL()
    .withMessage('Invalid URL')
    .matches(/^https?:\/\/(www\.)?github\.com\/[\w-]+\/[\w.-]+/)
    .withMessage('Must be a valid GitHub repository URL'),
  handleValidationErrors,
];

const validateFilePath = [
  query('path')
    .notEmpty()
    .withMessage('File path is required')
    .custom((value) => {
      // Prevent path traversal attacks
      const normalized = value.replace(/\\/g, '/');
      if (normalized.includes('..') || normalized.startsWith('/')) {
        throw new Error('Invalid file path');
      }
      return true;
    }),
  handleValidationErrors,
];

const validateFileContent = [
  body('path')
    .notEmpty()
    .withMessage('File path is required')
    .custom((value) => {
      const normalized = value.replace(/\\/g, '/');
      if (normalized.includes('..') || normalized.startsWith('/')) {
        throw new Error('Invalid file path');
      }
      return true;
    }),
  body('content')
    .exists()
    .withMessage('File content is required'),
  handleValidationErrors,
];

const validateRestart = [
  body('clean')
    .optional()
    .isBoolean()
    .withMessage('Clean must be a boolean'),
  handleValidationErrors,
];

module.exports = {
  validateBuildId,
  validateGithubRepo,
  validateFilePath,
  validateFileContent,
  validateRestart,
  handleValidationErrors,
};
