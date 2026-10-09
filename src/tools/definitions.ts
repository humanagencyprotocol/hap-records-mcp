/** The MCP tool surface — kept in its own module so tests can read it without starting the server. */
export const TOOL_DEFINITIONS = [
  // --- Search ---
  {
    name: "search_records",
    description:
      "Full-text search across all records. Returns matching records ranked by relevance. Use this to find information previously stored on behalf of the user.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search terms" },
        type: {
          type: "string",
          enum: ["note", "decision", "research", "bookmark", "reference"],
          description: "Limit search to a specific record type",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Filter to records with ALL of these tags",
        },
        archived: {
          type: "boolean",
          description: "Include archived records (default: false)",
        },
        limit: { type: "number", description: "Max results (default: 20)" },
      },
      required: ["query"],
    },
  },

  // --- Read ---
  {
    name: "get_record",
    description: "Get a single record by ID",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Record ID" },
      },
      required: ["id"],
    },
  },
  {
    name: "list_records",
    description:
      "List records, optionally filtered by type. Returns most recently updated first.",
    inputSchema: {
      type: "object",
      properties: {
        type: {
          type: "string",
          enum: ["note", "decision", "research", "bookmark", "reference"],
          description: "Filter by record type",
        },
        archived: {
          type: "boolean",
          description: "Show archived records (default: false)",
        },
        limit: { type: "number", description: "Max results (default: 50)" },
        offset: { type: "number", description: "Offset for pagination (default: 0)" },
      },
      required: [],
    },
  },

  // --- Write ---
  {
    name: "create_record",
    description:
      "Create a new record to store information on behalf of the user. Types: note (ideas, meeting notes, summaries), decision (choices with rationale), research (findings, analysis), bookmark (URLs, references), reference (documents, templates).",
    inputSchema: {
      type: "object",
      properties: {
        type: {
          type: "string",
          enum: ["note", "decision", "research", "bookmark", "reference"],
          description: "Record type",
        },
        title: { type: "string", description: "Record title" },
        content: {
          type: "string",
          description: "Record content (markdown). For decisions, include rationale and alternatives.",
        },
        metadata: {
          type: "object",
          description:
            "Structured metadata (varies by type). Examples: { url: '...' } for bookmarks, { outcome: '...', alternatives: [...] } for decisions, { source: '...' } for research.",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Tags for categorization and retrieval",
        },
        ticket_id: {
          type: "string",
          description:
            "Suveren mandate ticket id. Injected automatically by the gateway — agents do not set this.",
        },
      },
      required: ["type", "title"],
    },
  },
  {
    name: "update_record",
    description: "Update fields on an existing record. Only records created within the last 24 hours can be updated. For older records, create a new record instead.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Record ID" },
        title: { type: "string" },
        content: { type: "string" },
        metadata: { type: "object" },
        tags: { type: "array", items: { type: "string" } },
        type: {
          type: "string",
          enum: ["note", "decision", "research", "bookmark", "reference"],
        },
        ticket_id: {
          type: "string",
          description:
            "Suveren mandate ticket id for this edit. Injected automatically by the gateway — agents do not set this.",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "delete_record",
    description: "Permanently delete a record. Only records created within the last 24 hours can be deleted. For older records, use archive_record instead.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Record ID" },
      },
      required: ["id"],
    },
  },
  {
    name: "archive_record",
    description:
      "Archive a record. Archived records are hidden from default queries but can still be searched with archived=true.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Record ID" },
      },
      required: ["id"],
    },
  },

  // --- Export ---
  {
    name: "export_records",
    description: "Export all records as JSON",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
] as const;
