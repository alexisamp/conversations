import type { ContactDetail } from '../conv-api'

export function ContactDetailScreen({ contact }: { contact: ContactDetail }) {
  return (
    <div className="detail">
      <div className="detail-name">{contact.name}</div>
      {contact.company && <div className="detail-company">{contact.company}</div>}

      <div className="detail-meta">
        <div>
          <span className="label">Health</span>
          <span className="value">
            {contact.health_score != null ? `${contact.health_score}/10` : '–'}
          </span>
        </div>
        {contact.status && (
          <div>
            <span className="label">Status</span>
            <span className="value">{contact.status}</span>
          </div>
        )}
        {contact.last_interaction_at && (
          <div>
            <span className="label">Last interaction</span>
            <span className="value">
              {new Date(contact.last_interaction_at).toLocaleDateString()}
            </span>
          </div>
        )}
      </div>

      <h3>Recent interactions</h3>
      {contact.recent_interactions.length === 0 ? (
        <div className="empty small">No interactions yet.</div>
      ) : (
        <ul className="interactions">
          {contact.recent_interactions.map((i) => (
            <li key={i.id}>
              <div className="int-type">
                {i.type}
                {i.direction ? ` · ${i.direction}` : ''}
              </div>
              <div className="int-date">{i.interaction_date}</div>
              {i.notes && <div className="int-notes">{i.notes}</div>}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
