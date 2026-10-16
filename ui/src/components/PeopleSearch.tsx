import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Mail, Phone } from "lucide-react";
import { organisationsApi } from "@/api/organisations";
import { Input } from "@/components/ui/input";
import { Link } from "@/lib/router";
import { queryKeys } from "@/lib/queryKeys";

function useDebounced(value: string, delayMs: number) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

/** Find any person across every organisation by name, role, email, phone or organisation. */
export function PeopleSearch({ companyId }: { companyId: string }) {
  const [search, setSearch] = useState("");
  const q = useDebounced(search.trim(), 250);
  const query = useQuery({
    queryKey: queryKeys.organisations.people(companyId, q),
    queryFn: () => organisationsApi.searchPeople(companyId, q),
    enabled: q.length >= 2,
  });
  const people = query.data ?? [];
  return (
    <section aria-label="Find a person" className="space-y-2">
      <Input
        aria-label="Search people"
        placeholder="Find a person by name, role, email, phone or organisation"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        className="sm:w-96"
      />
      {q.length < 2 ? null : query.isLoading ? (
        <p className="text-sm text-muted-foreground">Searching people…</p>
      ) : query.error ? (
        <p className="text-sm text-destructive" role="alert">
          Could not search people. {query.error instanceof Error ? query.error.message : "Try again."}
        </p>
      ) : people.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nobody matches this search.</p>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border" aria-label="People found">
          {people.map((person) => (
            <li key={person.id} className="space-y-1 px-3 py-2 text-sm">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="font-medium">{person.name}</span>
                {person.role ? <span className="text-muted-foreground">({person.role})</span> : null}
                {person.organisationId && person.organisationName ? (
                  <Link to={`/organisations/${person.organisationId}`} className="hover:underline">
                    {person.organisationName}
                  </Link>
                ) : (
                  <span className="text-muted-foreground">No organisation</span>
                )}
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground">
                {person.email ? (
                  <a href={`mailto:${person.email}`} className="flex min-w-0 items-center gap-1 hover:text-foreground">
                    <Mail className="h-3.5 w-3.5 shrink-0" />
                    <span className="break-all">{person.email}</span>
                  </a>
                ) : null}
                {person.phone ? (
                  <a href={`tel:${person.phone}`} className="flex items-center gap-1 hover:text-foreground">
                    <Phone className="h-3.5 w-3.5 shrink-0" />
                    {person.phone}
                  </a>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
