import {
	sanitize_nox_html,
	type NoxHtmlPurifier,
} from '@opus-perpetuus/imperium-core-kit';
import DOMPurify from 'isomorphic-dompurify';

const purifier = DOMPurify as unknown as NoxHtmlPurifier;

/** Production HTML sanitizer for portal persist (same kit policy as tests). */
export function portal_html_sanitize(html: string): string {
	return sanitize_nox_html(html, purifier);
}
